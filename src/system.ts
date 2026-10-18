// ---------------------------------------------------------------------------
// Systems of parts: code and models composed over a simulated network, as
// one `Model`.
//
// A part is an independent owner of state that evolves by its own events,
// and the simulator sees every part through one interface, its `Kind`: the
// value a part starts from, the events its value allows, a runtime for a
// value, what an event does, and the value back. A part's value is a state
// the platform itself restarts from and every input since, so a runtime is
// rebuilt from the value alone, and a system of a thousand parts asks a
// state for its events without instantiating one of them.
//
//   state  = every part's value, by id, and the ids whose value has events
//   event  = one part's event. The candidates come first: what the parts
//            expect, in part order, or where nothing is expected each
//            active part's first event. Index 0 is free; the rest are
//            deviations.
//   applyEvent = restore the owner, run its `ingest`, drain the microtask
//            queue, then deliver what was sent, each message into a
//            restored receiver and drained after, until nothing is left;
//            snapshot the parts touched, and keep every other value.
//
// Parts talk by message, through the step, and never hold one another's
// runtime: a runtime is rebuilt on demand, from the value, and a replay has
// no step to send through. The system keeps the live runtime of each part
// after a step and resumes it when a later step finds the part at that
// value; the rebuild check then runs the step again from the value alone,
// and compares.
//
// A `SystemError` is the test's error, not the system's failure: a message
// to a part that does not exist, code that departs from its log on replay,
// a host call outside a step, a rebuilt part that differs from the live
// one, an `ingest` that is asynchronous. The search rejects with it, as
// with a `DecisionsError` (D37).
//
// Why: DECISIONS.md D38 to D44.
// ---------------------------------------------------------------------------

import { ValueMap, ValueSet, deepEqual, intern } from 'valsem';
import type { EventDescriptor, FormatOptions, InvariantResult, Model } from './search.js';

/** What a part can do next: the event, whether the part expects it, and what it is charged. */
export interface Offer<Event> {
  event: Event;
  /** The sunny-day event, a candidate for the free step. A part may expect none or several. */
  expected?: boolean | undefined;
  /** The cost keys taking it charges, one unit per occurrence. */
  cost?: readonly string[] | undefined;
}

/** A step in progress: how a part reaches a peer. */
export interface Step {
  /**
   * Send `message` to the part called `to`. It is delivered after this
   * part's work is done and its microtasks have drained, into the peer's
   * `receive`, with the peer restored first. A peer that does not exist
   * comes to exist, if the system's `kindOf` knows its kind.
   */
  send(to: string, message: unknown): void;
}

/**
 * A kind of part: how the system sees every part of it. A part's state is
 * split into a value for the cache, which must be a valsem value, and a
 * runtime for the code, which is the kind's own.
 */
export interface Kind<Value, Runtime, Event> {
  /** The value a part of this kind starts from. */
  initial(id: string): Value;
  /**
   * What a part with this value can do next. A function of the value
   * alone, never of a runtime: the system asks it of every active part
   * without restoring one. Must be pure.
   */
  events(value: Value): readonly Offer<Event>[];
  /** A runtime for the value, rebuilt from it alone: nothing of another
   *  part, and nothing sent. The system resumes a live runtime itself. */
  restore(id: string, value: Value): Runtime | Promise<Runtime>;
  /** Do one of the events `events` offered for the runtime's value. */
  ingest(runtime: Runtime, event: Event, step: Step): void;
  /** Take a message a peer sent. */
  receive(runtime: Runtime, from: string, message: unknown, step: Step): void;
  /** The value back, after a step. */
  snapshot(runtime: Runtime): Value;
  /** A harness error the kind recorded outside a step — a host call from
   *  work the model does not see — for the system to raise at its next
   *  step. */
  fault?(): SystemError | undefined;
  /** How an event of a part with this value reads, for a report. */
  describeEvent?(event: Event, value: Value, id: string): string;
  /** How a value reads, for a report. */
  describeValue?(value: Value, id: string): string;
}

/** A kind of any part: what a system is made of. */
export type AnyKind = Kind<unknown, unknown, unknown>;

/** A value part's runtime: a cell holding its value for the length of a step. */
export interface Cell<Value> {
  value: Value;
}

/** A kind whose runtime is its value: a part written as a reducer. */
export type ValueKind<Value, Event> = Omit<Kind<Value, Cell<Value>, Event>, 'restore' | 'snapshot'>;

/** A kind from its value part: `restore` puts the value in a cell, `snapshot` takes it out. */
export function valuePart<Value, Event>(kind: ValueKind<Value, Event>): Kind<Value, Cell<Value>, Event> {
  return { ...kind, restore: (_id, value) => ({ value }), snapshot: (cell) => cell.value };
}

declare const brand: unique symbol;
/**
 * The state of a system: every part's value by id. What it holds is not
 * API, only that it is a value; `partsOf` gives the values, and
 * `describeState` says how it reads.
 */
export interface SystemState {
  readonly [brand]: 'SystemState';
}

/** An event of a system: one part's event. */
export interface SystemEvent {
  part: string;
  event: unknown;
}

/**
 * The test's error, never the system's failure: a message to a part that
 * does not exist, code that departs from its log on replay, a host call
 * outside a step, a rebuilt part that differs from the live one. The
 * search rejects with it.
 */
export class SystemError extends Error {
  constructor(message: string) {
    super(`stifinder: ${message}`);
    this.name = 'SystemError';
  }
}

/** The values of the parts a test names, by id, and of any other by id. */
export type PartValues<Parts> = { readonly [Id in keyof Parts]: Parts[Id] extends Kind<infer Value, unknown, unknown> ? Value : never } & {
  readonly [id: string]: unknown;
};

export interface SystemOptions<Parts> {
  /**
   * The kind of a part the test did not name: one that comes to exist when
   * a message first reaches its id, with `initial(id)` as its value.
   * Without it a message to an unknown id is a `SystemError`.
   */
  kindOf?: ((id: string) => AnyKind | undefined) | undefined;
  /** What must hold in every reachable state, of the parts' values. As `Model.invariant`. */
  invariant?: ((parts: PartValues<Parts>) => InvariantResult | Promise<InvariantResult>) | undefined;
  /** What must hold wherever the system stops: where no part has an event.
   *  As `Model.terminalInvariant`: a throw is the violation, and so is
   *  `{ error }` returned; anything else returned is nothing. */
  ends?: ((parts: PartValues<Parts>) => InvariantResult | Promise<InvariantResult>) | undefined;
  /**
   * Whether a step that resumed a live runtime is run again from the
   * values alone, and the two compared: a difference means state lived
   * outside a value, and is a `SystemError`. Default: true.
   */
  rebuildCheck?: boolean | undefined;
  /** How a violation is rendered. Default: every step. */
  report?: FormatOptions | undefined;
}

/** The parts' values of a state, by id. */
export function partsOf(state: SystemState): ValueMap<string, unknown> {
  return productOf(state).parts;
}

// The drain after a part's work: a yield to the macrotask queue, with the
// real timer as it was when stifinder loaded, since a test that fakes
// timers fakes it too. The microtask queue is empty by the time it runs.
const defer: (callback: () => void) => void = typeof setImmediate === 'function' ? setImmediate : (callback) => setTimeout(callback, 0);
/** @internal Resolves once the microtask queue has drained. */
export const _drain = (): Promise<void> => new Promise((resolve) => defer(resolve));

interface Product {
  parts: ValueMap<string, unknown>;
  active: ValueSet<string>;
  /** Set on the one state a harness error leads to. */
  poison?: true;
}
const productOf = (state: SystemState): Product => state as unknown as Product;
const stateOf = (product: Product): SystemState => product as unknown as SystemState;
const POISON: Product = { parts: ValueMap.empty(), active: ValueSet.empty(), poison: true };

/** @internal A value shown as it is: a string plainly, anything else as JSON. */
export function _plain(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    const json: unknown = JSON.stringify(value);
    if (typeof json === 'string') return json;
  } catch {
    // A cycle, or a bigint inside.
  }
  return String(value);
}

/**
 * What a property returned, as a verdict: `{ error }` for a failure, and
 * nothing for anything else. A property written as an arrow returning an
 * assertion library's chain, `({ client }) => expect(client.result).toEqual(...)`,
 * returns that chain, which is no verdict; the assertion itself throws.
 * Only a plain object is read, since such a chain may be a proxy that
 * throws on any property read.
 */
function verdict(outcome: unknown): InvariantResult {
  if (typeof outcome !== 'object' || outcome === null) return undefined;
  const proto: unknown = Object.getPrototypeOf(outcome);
  if (proto !== Object.prototype && proto !== null) return undefined;
  return 'error' in outcome ? outcome : undefined;
}

/** What one step did: the values of the parts it touched, and the messages that crossed. */
interface StepResult {
  values: Map<string, unknown>;
  messages: { from: string; to: string; message: unknown }[];
  /** True if a live runtime was resumed, rather than rebuilt. */
  resumed: boolean;
}

/**
 * The parts as one model. The parts a test names are there from the
 * start, in the order named; a part `kindOf` knows comes to exist when a
 * message first reaches it. The system's events are the parts' events,
 * candidates first; its step restores the owner, runs the event, drains,
 * and delivers what was sent; `invariant` and `ends` are checked over the
 * parts' values. A search of it is `check(system(...))`.
 */
export function system<Parts extends Record<string, AnyKind>>(parts: Parts, options: SystemOptions<Parts> = {}): Model<SystemState, SystemEvent> {
  const declared = Object.keys(parts);
  const named = new Set(declared);
  const kinds = new Map<string, AnyKind>(Object.entries(parts));
  const rebuildCheck = options.rebuildCheck ?? true;
  /** The live runtime of each part after its last step, with the value it is at. */
  const live = new Map<string, { runtime: unknown; value: unknown }>();
  let harness: SystemError | null = null;

  const kindAt = (id: string): AnyKind => {
    const known = kinds.get(id);
    if (known !== undefined) return known;
    const found = options.kindOf?.(id);
    if (found === undefined) {
      throw new SystemError(
        `no part is called ${JSON.stringify(id)}${options.kindOf === undefined ? ', and the system has no kindOf for parts that come to exist' : ', and kindOf does not know it'}`,
      );
    }
    kinds.set(id, found);
    return found;
  };
  const isActive = (id: string, value: unknown): boolean => kindAt(id).events(value).length > 0;
  /** A harness error any kind has recorded since its last step. */
  const recorded = (): SystemError | null => {
    for (const kind of kinds.values()) {
      const fault = kind.fault?.();
      if (fault !== undefined) return fault;
    }
    return null;
  };
  /** `ingest` and `receive` are synchronous: a step is over when its drain is, which a promise would outlive. */
  const synchronous = (id: string, what: string, returned: unknown): void => {
    if (returned instanceof Promise) {
      // Nothing waits for it: the step has moved on without it.
      returned.catch(() => undefined);
      throw new SystemError(`${JSON.stringify(id)}'s ${what} returned a promise: a part's work is synchronous, and its microtasks run before the step ends`);
    }
  };
  /** Part order: the parts named, as named, then the rest by id. */
  const inPartOrder = (ids: Iterable<string>): string[] => {
    const present = new Set(ids);
    const rest = [...present].filter((id) => !named.has(id)).sort();
    return [...declared.filter((id) => present.has(id)), ...rest];
  };
  const valuesOf = (product: Product): PartValues<Parts> => Object.fromEntries(product.parts.entries()) as PartValues<Parts>;
  const describeValue = (id: string, value: unknown): string => kindAt(id).describeValue?.(value, id) ?? _plain(value);

  /** A value as the cache will hold it; a value valsem cannot hold is the kind's error. */
  const canonical = (id: string, value: unknown): unknown => {
    try {
      return intern(value);
    } catch (error) {
      throw new SystemError(`${JSON.stringify(id)}'s value is not a value: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /** One step: `event` of `part` at `product`, with live runtimes resumed or every part rebuilt. */
  async function runStep(product: Product, part: string, event: unknown, resume: boolean): Promise<StepResult> {
    const runtimes = new Map<string, { kind: AnyKind; runtime: unknown }>();
    let resumed = false;
    const restored = async (id: string): Promise<unknown> => {
      const have = runtimes.get(id);
      if (have !== undefined) return have.runtime;
      const kind = kindAt(id);
      const value = product.parts.has(id) ? product.parts.get(id) : canonical(id, kind.initial(id));
      const kept = resume ? live.get(id) : undefined;
      let runtime: unknown;
      if (kept !== undefined && kept.value === value) {
        // Taken out while the step changes it, so that a step of another
        // search at the same value rebuilds its own; put back at the snapshot.
        live.delete(id);
        runtime = kept.runtime;
        resumed = true;
      } else {
        runtime = await kind.restore(id, value);
      }
      runtimes.set(id, { kind, runtime });
      return runtime;
    };
    const messages: StepResult['messages'] = [];
    const mail: StepResult['messages'] = [];
    const stepFor = (from: string): Step => ({
      send: (to, message) => {
        mail.push({ from, to, message });
      },
    });

    // A step that fails leaves no runtime it changed in `live`: one it
    // resumed was taken out, and one it rebuilt never went in.
    synchronous(part, 'ingest', kindAt(part).ingest(await restored(part), event, stepFor(part)));
    await _drain();
    for (let next = mail.shift(); next !== undefined; next = mail.shift()) {
      messages.push(next);
      synchronous(next.to, 'receive', kindAt(next.to).receive(await restored(next.to), next.from, next.message, stepFor(next.to)));
      await _drain();
    }
    const values = new Map<string, unknown>();
    for (const [id, { kind, runtime }] of runtimes) values.set(id, canonical(id, kind.snapshot(runtime)));
    if (resume) for (const [id, { runtime }] of runtimes) live.set(id, { runtime, value: values.get(id) });
    return { values, messages, resumed };
  }

  /** How a step with live runtimes differed from one rebuilt, or null. */
  function difference(a: StepResult, b: StepResult): string | null {
    for (const [id, value] of a.values) {
      if (!b.values.has(id)) return `the rebuilt step did not touch ${JSON.stringify(id)}`;
      if (b.values.get(id) !== value) {
        return `${JSON.stringify(id)} is ${describeValue(id, value)} live, and ${describeValue(id, b.values.get(id))} rebuilt`;
      }
    }
    for (const id of b.values.keys()) if (!a.values.has(id)) return `the live step did not touch ${JSON.stringify(id)}`;
    if (!deepEqual(a.messages, b.messages)) return 'the messages sent differ';
    return null;
  }

  const initial: Product = {
    parts: ValueMap.from(declared.map((id) => [id, canonical(id, kinds.get(id)!.initial(id))] as const)),
    active: ValueSet.empty(),
  };
  initial.active = ValueSet.from(declared.filter((id) => isActive(id, initial.parts.get(id))));

  return {
    initialState: stateOf(initial),

    getEvents(state) {
      harness ??= recorded();
      if (harness !== null) throw harness;
      const product = productOf(state);
      const offers = inPartOrder(product.active).flatMap((part) =>
        kindAt(part)
          .events(product.parts.get(part))
          .map((offer) => ({ part, ...offer })),
      );
      // The candidates: what the parts expect, or where nothing is
      // expected each active part's first event. One is free, at index 0.
      let candidates = offers.filter((offer) => offer.expected);
      if (candidates.length === 0) {
        const seen = new Set<string>();
        candidates = offers.filter((offer) => !seen.has(offer.part) && seen.add(offer.part));
      }
      const rest = offers.filter((offer) => !candidates.includes(offer));
      return [...candidates, ...rest].map(
        ({ part, event, cost }): EventDescriptor<SystemEvent> => (cost === undefined ? { event: { part, event } } : { event: { part, event }, cost }),
      );
    },

    async applyEvent(state, { part, event }) {
      harness ??= recorded();
      if (harness !== null) return { to: stateOf(POISON) };
      const product = productOf(state);
      try {
        const step = await runStep(product, part, event, true);
        if (rebuildCheck && step.resumed) {
          const again = await runStep(product, part, event, false);
          const differs = difference(step, again);
          if (differs !== null) {
            throw new SystemError(`the rebuild check failed on ${JSON.stringify(part)}'s event ${_plain(event)}: ${differs}. State lived outside a value`);
          }
        }
        let { parts: values, active } = product;
        for (const [id, value] of step.values) {
          values = values.with(id, value);
          let hasEvents: boolean;
          try {
            hasEvents = isActive(id, value);
          } catch (error) {
            // As a throw from `getEvents`: the test's error, not the system's failure.
            throw error instanceof SystemError ? error : new SystemError(`${JSON.stringify(id)}'s events threw: ${error instanceof Error ? error.message : String(error)}`);
          }
          active = hasEvents ? active.added(id) : active.deleted(id);
        }
        return { to: stateOf({ parts: values, active }) };
      } catch (error) {
        if (error instanceof SystemError) {
          harness = error;
          return { to: stateOf(POISON) };
        }
        return { error };
      }
    },

    async invariant(state) {
      const product = productOf(state);
      if (product.poison || options.invariant === undefined) return undefined;
      return verdict(await options.invariant(valuesOf(product)));
    },

    async terminalInvariant(state) {
      const product = productOf(state);
      if (product.poison || options.ends === undefined) return undefined;
      return verdict(await options.ends(valuesOf(product)));
    },

    describeEvent({ part, event }, state) {
      const product = productOf(state);
      const value = product.parts.get(part);
      return kindAt(part).describeEvent?.(event, value, part) ?? `${part}: ${_plain(event)}`;
    },

    describeState(state) {
      const product = productOf(state);
      if (product.poison) return 'after a harness error';
      return inPartOrder(product.parts.keys())
        .map((id) => `${id}: ${describeValue(id, product.parts.get(id))}`)
        .join('; ');
    },

    ...(options.report === undefined ? {} : { report: options.report }),
  };
}
