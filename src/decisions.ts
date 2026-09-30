// ---------------------------------------------------------------------------
// Code that decides: a body of code, explored through the decisions it asks
// for.
//
// The body is a function of a `Decisions` object, which it asks at every
// point where more than one thing could happen next: whether a send fails,
// which of two values arrives, which task runs. Under the search:
//
//   state  = the decisions made so far
//   event  = the next decision, 0 first, so that any other pick is a
//            deviation from the expected run
//   applyEvent(prefix, k) = the state one decision longer; the body is run
//            with prefix + [k] replayed and 0 answered to every decision
//            after, and every state along that default continuation is
//            harvested from the one run
//
// A run that throws attributes the error to the last state it reached,
// where the model's `invariant` reports it. So a body that throws before
// its first decision fails at the initial state, and a body that returns a
// promise is awaited. Neither was so in kilde's adapter, which this is the
// move of (D36).
//
// A wrong use of `Decisions`, a body whose decisions change between runs,
// or a run past the decision cap is a `DecisionsError`: not a failure of
// the body, but of the test. It is thrown through the body, remembered if
// the body catches it, and handed to the search from `getEvents`, the one
// callback whose throw the search does not take for an error of the model.
// So `check` rejects with it, at the moment it occurs (D37).
// ---------------------------------------------------------------------------

import { HashMap } from 'valsem';
import type { EventDescriptor, FormatOptions, Model, ViolationPath } from './search.js';
import type { ViolationError } from './report.js';

/** How a pick of `integer` reads in a report: words for a pick that is not
 *  0, or a function of the pick. */
export type DecisionLabel = string | ((pick: number) => string);

/** One of the things `choose` can pick. */
export interface Alternative<T> {
  value: T;
  /** How picking it reads in a report. */
  label?: string;
  /** The cost keys picking it charges, one unit per occurrence. The first
   *  alternative's are charged too, on the expected run. */
  cost?: readonly string[];
}

/**
 * What a body asks when more than one thing could happen next. Every
 * answer is the expected one, 0 or the first alternative, unless the
 * search is exploring a deviation there.
 */
export interface Decisions {
  /**
   * Pick an integer in [0, range). 0 is the expected pick; any other is a
   * deviation. `label` says what a pick other than 0 means, in words, for
   * the report of a failing run: "sink pauses after value #2". A function
   * is given the pick, for ranges above 2. A range of 1 is no decision.
   */
  integer(range: number, label?: DecisionLabel): number;
  /**
   * Whether something happens that is not expected to: false, unless the
   * search is exploring the deviation. `label` says what that is, in words,
   * and `cost` the keys it charges: `maybe('the send fails', { cost:
   * ['fault'] })`.
   */
  maybe(label: string, options?: { cost?: readonly string[] }): boolean;
  /**
   * Pick one of `alternatives`, and return its value. The first is the
   * expected pick; any other is a deviation. Each charges the cost keys it
   * lists. One alternative is no decision.
   */
  choose<const T>(alternatives: readonly Alternative<T>[]): T;
}

/** A body of code under test. What it returns is ignored, unless it is a
 *  promise, which is awaited: its rejection is the body's failure. */
export type DecisionBody = (decide: Decisions) => unknown;

declare const brand: unique symbol;
/**
 * The decisions made so far, as a state of the search. What it holds is not
 * API, only that it is a value: `describeState` says how it reads, and
 * `decisionsOf` gives the decisions of a violation.
 */
export interface DecisionState {
  readonly [brand]: 'DecisionState';
}

export interface DecisionModelOptions {
  /**
   * The most decisions one run of the body may make. Past it the run is a
   * `DecisionsError`: a body whose expected run never ends would otherwise
   * hang the search, since no limit of the search can interrupt a run.
   * Default: 10,000.
   */
  maxDecisions?: number;
  /** How a violation is rendered. Default: the charged steps alone. */
  report?: FormatOptions;
}

/** The model of a body, as `decisionModel` builds it. */
export interface DecisionModel extends Model<DecisionState, number> {
  /**
   * How many times the body has been run, by every search of this model:
   * what a run finds is kept on the model, so a second search of it reruns
   * nothing.
   */
  readonly runs: number;
}

/**
 * A wrong use of `Decisions`, a body whose decisions change between runs,
 * or a run of the body past `maxDecisions`. It is the test that is wrong,
 * not the code under it, so this is never reported as a violation: the
 * search rejects with it.
 */
export class DecisionsError extends Error {
  constructor(message: string) {
    super(`stifinder: ${message}`);
    this.name = 'DecisionsError';
  }
}

const DEFAULT_MAX_DECISIONS = 10_000;

type Picks = readonly number[];
const picksOf = (state: DecisionState): Picks => state as unknown as Picks;
const stateOf = (picks: Picks): DecisionState => picks as unknown as DecisionState;

/** What a decision point offers: its size, how a pick reads, and what each pick charges. */
interface Branch {
  kind: 'branch';
  range: number;
  describe: (pick: number) => string;
  costs: (readonly string[] | undefined)[] | undefined;
}
/** What a run found at a state: a decision to make, its end, its failure,
 *  or a `DecisionsError` for `getEvents` to throw. */
type Entry = Branch | { kind: 'done' } | { kind: 'error'; error: unknown } | { kind: 'harness'; error: DecisionsError };

const describeInteger =
  (label: DecisionLabel | undefined, range: number) =>
  (pick: number): string => {
    if (typeof label === 'function') return label(pick);
    if (label === undefined) return `picked ${pick} of ${range}`;
    if (pick === 0) return `${label}: no`;
    return range > 2 ? `${label} (pick ${pick})` : label;
  };

/**
 * The `Decisions` of one run: replays `picks`, then answers 0. With
 * `expected`, the range each replayed decision had when it was first met,
 * a body whose decisions have changed is caught. The first
 * `DecisionsError` is kept, and thrown again by every later decision, so
 * a body that catches it cannot go on as if it had not happened.
 */
class Replay implements Decisions {
  #index = 0;
  readonly branches: Branch[] = [];
  /** The first wrong use, if any: `run` throws it once the body is done. */
  error: DecisionsError | null = null;

  constructor(
    private readonly picks: Picks,
    private readonly expected: readonly (number | undefined)[] | undefined,
    private readonly maxDecisions: number,
  ) {}

  /** Decision points consulted so far. */
  get consulted(): number {
    return this.#index;
  }

  #fail(message: string): never {
    this.error ??= new DecisionsError(message);
    throw this.error;
  }

  #decide(branch: Branch): number {
    if (this.error !== null) throw this.error;
    const i = this.#index;
    if (i >= this.maxDecisions) {
      this.#fail(`the body made more than ${this.maxDecisions} decisions in one run (maxDecisions)`);
    }
    this.#index++;
    this.branches.push(branch);
    if (i >= this.picks.length) return 0;
    const pick = this.picks[i]!;
    const expected = this.expected?.[i];
    if (expected !== undefined && expected !== branch.range) {
      this.#fail(`decision ${i} had ${expected} alternatives before and ${branch.range} now: the body is not deterministic`);
    }
    if (!Number.isInteger(pick) || pick < 0 || pick >= branch.range) {
      this.#fail(`decision ${i} has ${branch.range} alternatives, and pick ${pick} is not one of them`);
    }
    return pick;
  }

  integer(range: number, label?: DecisionLabel): number {
    if (!Number.isInteger(range) || range < 1) {
      this.#fail(`integer(range) needs a whole range of 1 or more, not ${String(range)}`);
    }
    if (range === 1) return 0;
    return this.#decide({ kind: 'branch', range, describe: describeInteger(label, range), costs: undefined });
  }

  maybe(label: string, options?: { cost?: readonly string[] }): boolean {
    const costs = options?.cost === undefined ? undefined : [undefined, options.cost];
    return this.#decide({ kind: 'branch', range: 2, describe: describeInteger(label, 2), costs }) === 1;
  }

  choose<const T>(alternatives: readonly Alternative<T>[]): T {
    if (alternatives.length === 0) this.#fail('choose() needs at least one alternative');
    if (alternatives.length === 1) return alternatives[0]!.value;
    const pick = this.#decide({
      kind: 'branch',
      range: alternatives.length,
      describe: (k) => alternatives[k]?.label ?? `alternative ${k}`,
      costs: alternatives.map((a) => a.cost),
    });
    return alternatives[pick]!.value;
  }
}

/**
 * The model of `body`: a state is the decisions made so far, an event the
 * next one. Every callback runs the body at most once per state, and keeps
 * what it finds along the way, on the model. A search of it is
 * `check(decisionModel(body))`.
 */
export function decisionModel(body: DecisionBody, options?: DecisionModelOptions): DecisionModel {
  const maxDecisions = options?.maxDecisions ?? DEFAULT_MAX_DECISIONS;
  if (!Number.isInteger(maxDecisions) || maxDecisions < 1) {
    throw new RangeError(`stifinder: maxDecisions must be a whole number of 1 or more, not ${String(maxDecisions)}`);
  }
  const table = new HashMap<Picks, Entry>();
  let runs = 0;

  /** Run the body for `picks`, and record every state along its default continuation. */
  async function run(picks: Picks): Promise<void> {
    runs++;
    const expected = picks.map((_, i) => {
      const entry = table.get(picks.slice(0, i));
      return entry?.kind === 'branch' ? entry.range : undefined;
    });
    const replay = new Replay(picks, expected, maxDecisions);
    let failure: { error: unknown } | null = null;
    try {
      await body(replay);
    } catch (error) {
      failure = { error };
    }
    // A wrong use is the test's error, whatever the body did with it. It is
    // kept for `getEvents` to throw, on the state that was asked about.
    if (replay.error === null && replay.consulted < picks.length) {
      replay.error = new DecisionsError(
        `the body made ${replay.consulted} decisions, but ${picks.length} had been made before: it is not deterministic`,
      );
    }
    if (replay.error !== null) {
      table.set(picks, { kind: 'harness', error: replay.error });
      return;
    }
    // States along the default chain: picks, picks + [0], picks + [0, 0], …
    let chain = picks;
    for (let i = picks.length; i < replay.branches.length; i++) {
      table.set(chain, replay.branches[i]!);
      chain = [...chain, 0];
    }
    table.set(chain, failure === null ? { kind: 'done' } : { kind: 'error', error: failure.error });
  }

  async function entryFor(picks: Picks): Promise<Entry> {
    const known = table.get(picks);
    if (known !== undefined) return known;
    await run(picks);
    return table.get(picks)!;
  }

  const model: DecisionModel = {
    initialState: stateOf([]),
    // A run's failure is a fact about the state it reached: the initial
    // state included, which is what an error reported on edges cannot say.
    async invariant(state) {
      const entry = await entryFor(picksOf(state));
      return entry.kind === 'error' ? { error: entry.error } : undefined;
    },
    async getEvents(state) {
      const entry = await entryFor(picksOf(state));
      if (entry.kind === 'harness') throw entry.error;
      if (entry.kind !== 'branch') return [];
      const events: EventDescriptor<number>[] = [];
      for (let k = 0; k < entry.range; k++) {
        const cost = entry.costs?.[k];
        events.push(cost === undefined ? { event: k } : { event: k, cost });
      }
      return events;
    },
    applyEvent: (state, pick) => ({ to: stateOf([...picksOf(state), pick]) }),
    describeEvent(pick, state) {
      const entry = table.get(picksOf(state));
      return entry?.kind === 'branch' ? entry.describe(pick) : `picked ${pick} of ?`;
    },
    describeState: (state) => `decisions [${picksOf(state).join(', ')}]`,
    report: options?.report ?? { steps: 'charged' },
    get runs() {
      return runs;
    },
  };
  return model;
}

/**
 * The decisions of a violation of a body's model, from a `ViolationError`
 * or the path itself: what `runOnce` takes to see the failure again.
 */
export function decisionsOf(violation: ViolationPath<unknown, unknown> | ViolationError<unknown, unknown>): number[] {
  const path = 'violation' in violation ? violation.violation : violation;
  return path.steps.map((step, i) => {
    if (typeof step.event !== 'number') throw new DecisionsError(`step ${i + 1} of this violation is not a decision: it is not of a body`);
    return step.event;
  });
}

/**
 * Run `body` once, with `decisions` replayed and 0 answered to every
 * decision after them: the way to see a reported failure again, under a
 * debugger. Takes the decisions, or the violation or `ViolationError` they
 * are in. Rejects with what the body throws.
 */
export async function runOnce(
  body: DecisionBody,
  decisions: readonly number[] | ViolationPath<unknown, unknown> | ViolationError<unknown, unknown>,
): Promise<void> {
  const picks = Array.isArray(decisions) ? (decisions as readonly number[]) : decisionsOf(decisions as ViolationPath<unknown, unknown>);
  const replay = new Replay(picks, undefined, Infinity);
  try {
    await body(replay);
  } finally {
    if (replay.error !== null) throw replay.error;
  }
  if (replay.consulted < picks.length) {
    throw new DecisionsError(`the body made ${replay.consulted} decisions of the ${picks.length} given`);
  }
}
