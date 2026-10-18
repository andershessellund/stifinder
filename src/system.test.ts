// ---------------------------------------------------------------------------
// Systems of parts: the step, the candidates, the registry, the rebuild
// check, and the harness errors; then the differential oracle, random
// systems of value parts against an eager product written straight from
// the rules, as oracle.test.ts does for the search.
//
//     FUZZ_RUNS=2000 FUZZ_SEED=7 pnpm test system
// ---------------------------------------------------------------------------
import { describe, expect, it, vi } from 'vitest';
import { deepEqual } from 'valsem';
import {
  type CostVector,
  type Model,
  type SystemEvent,
  type SystemState,
  SystemError,
  ViolationError,
  check,
  exploreIteratively,
  partsOf,
  system,
  valuePart,
} from './index.js';

const RUNS = Number(process.env.FUZZ_RUNS ?? 150);
const SEED = Number(process.env.FUZZ_SEED ?? 1);

/** A part that pings a peer `times` times, and counts what it is sent. */
const pinger = (peer: string, times: number) =>
  valuePart<{ sent: number; got: number }, 'ping'>({
    initial: () => ({ sent: 0, got: 0 }),
    events: (value) => (value.sent < times ? [{ event: 'ping', expected: true }] : []),
    ingest(cell, _event, step) {
      cell.value = { ...cell.value, sent: cell.value.sent + 1 };
      step.send(peer, 'ping');
    },
    receive(cell) {
      cell.value = { ...cell.value, got: cell.value.got + 1 };
    },
  });

/** A part that offers what it is told, and does nothing but move to the event's `to`. */
const offering = (offers: Record<string, { event: string; expected?: boolean; cost?: string[]; to?: string }[]>, start = 'a') =>
  valuePart<string, string>({
    initial: () => start,
    events: (value) => (offers[value] ?? []).map(({ event, expected, cost }) => ({ event, expected, cost })),
    ingest(cell, event) {
      cell.value = (offers[cell.value] ?? []).find((offer) => offer.event === event)?.to ?? cell.value;
    },
    receive() {},
  });

const tupleOf = (state: SystemState): Record<string, unknown> => Object.fromEntries(partsOf(state).entries());
const eventsOf = async (model: Model<SystemState, SystemEvent>, state: SystemState) =>
  (await model.getEvents(state)).map(({ event, cost }) => ({ ...event, ...(cost === undefined ? {} : { cost }) }));

describe('system: the step', () => {
  it('runs the owner, drains, and delivers what it sent into a restored receiver, in the order sent', async () => {
    const model = system({ a: pinger('b', 2), b: pinger('a', 0) });
    const space = await check(model);
    expect(space.exhaustive).toBe(true);
    const end = [...space.costs.keys()].map(tupleOf).find((tuple) => (tuple.a as { sent: number }).sent === 2);
    expect(end).toEqual({ a: { sent: 2, got: 0 }, b: { sent: 0, got: 2 } });
  });

  it('a message sent while receiving is delivered too, after the receiver has drained', async () => {
    const echo = valuePart<number, never>({
      initial: () => 0,
      events: () => [],
      ingest() {},
      receive(cell, from, message, step) {
        cell.value++;
        if (message === 'ping') step.send(from, 'pong');
      },
    });
    const model = system({ a: pinger('b', 1), b: echo });
    const space = await check(model);
    const end = [...space.costs.keys()].map(tupleOf).find((tuple) => (tuple.a as { sent: number }).sent === 1);
    expect(end).toEqual({ a: { sent: 1, got: 1 }, b: 1 });
  });

  it('keeps every value a step did not touch, and asks no idle part for its events', async () => {
    const idle = offering({});
    const events = vi.spyOn(idle, 'events');
    const model = system({ a: pinger('b', 3), b: pinger('a', 0), idle });
    await check(model);
    // Once, for the initial state's active set.
    expect(events).toHaveBeenCalledTimes(1);
  });

  it('a part comes to exist when a message first reaches it, with initial(id), if kindOf knows its kind', async () => {
    const model = system({ a: pinger('fresh-1', 1) }, { kindOf: (id) => (id.startsWith('fresh') ? pinger('a', 0) : undefined) });
    const space = await check(model);
    const end = [...space.costs.keys()].map(tupleOf).find((tuple) => 'fresh-1' in tuple);
    expect(end).toEqual({ a: { sent: 1, got: 0 }, 'fresh-1': { sent: 0, got: 1 } });
    expect(tupleOf(space.initialState)).toEqual({ a: { sent: 0, got: 0 } });
  });

  it('a message to a part that does not exist is a SystemError: the search rejects', async () => {
    await expect(check(system({ a: pinger('nobody', 1) }))).rejects.toThrow(
      new SystemError('no part is called "nobody", and the system has no kindOf for parts that come to exist'),
    );
    await expect(check(system({ a: pinger('nobody', 1) }, { kindOf: () => undefined }))).rejects.toThrow(SystemError);
    await expect(check(system({ a: pinger('nobody', 1) }, { kindOf: () => undefined }))).rejects.toThrow(/kindOf does not know it/);
  });

  it('a SystemError from a part rejects the search; any other throw is the failure of the system', async () => {
    const touchy = (error: Error) =>
      valuePart<number, 'go'>({
        initial: () => 0,
        events: (value) => (value === 0 ? [{ event: 'go', expected: true }] : []),
        ingest() {
          throw error;
        },
        receive() {},
      });
    await expect(check(system({ a: touchy(new SystemError('wired wrong')) }))).rejects.toThrow(new SystemError('wired wrong'));
    const failure = await check(system({ a: touchy(new Error('boom')) })).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ViolationError);
    expect((failure as ViolationError).message.split('\n')).toEqual(['boom', '0 deviations, 1 step', '  1. a: go']);
  });

  it('a value a kind gives that is not a value is the kind\'s error', async () => {
    const bad = valuePart<unknown, 'go'>({
      initial: () => 0,
      events: (value) => (value === 0 ? [{ event: 'go', expected: true }] : []),
      ingest(cell) {
        cell.value = () => 1;
      },
      receive() {},
    });
    await expect(check(system({ a: bad }))).rejects.toThrow(/"a"'s value is not a value/);
  });

  it('a runtime a failed step changed is forgotten: the next step at that value rebuilds it', async () => {
    // At 1, `boom` changes the runtime and then throws; `ok` is the other way on.
    const kind = valuePart<number, 'go' | 'boom' | 'ok'>({
      initial: () => 0,
      events: (value) => (value === 0 ? [{ event: 'go', expected: true }] : value === 1 ? [{ event: 'boom', expected: true }, { event: 'ok' }] : []),
      ingest(cell, event) {
        if (event === 'go') cell.value = 1;
        else if (event === 'ok') cell.value = 2;
        else {
          cell.value = 100;
          throw new Error('boom');
        }
      },
      receive() {},
    });
    for (const rebuildCheck of [true, false]) {
      const space = await exploreIteratively(system({ a: kind }, { rebuildCheck }), { stopOnViolation: false });
      expect(space.violation?.error).toEqual(new Error('boom'));
      expect([...space.costs.keys()].map((state) => partsOf(state).get('a')).sort()).toEqual([0, 1, 2]);
    }
  });

  it('an ingest or receive that returns a promise is a SystemError: a part\'s work is synchronous', async () => {
    const lazy = valuePart<number, 'go'>({
      initial: () => 0,
      events: (value) => (value === 0 ? [{ event: 'go', expected: true }] : []),
      // The misuse under test.
      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      ingest: async (cell) => {
        cell.value = 1;
      },
      receive() {},
    });
    await expect(check(system({ a: lazy }))).rejects.toThrow(/"a"'s ingest returned a promise: a part's work is synchronous/);
  });

  it('events that throw are the test\'s error from a step too, as they are from getEvents', async () => {
    const broken = valuePart<number, 'go'>({
      initial: () => 0,
      events: (value) => {
        if (value === 1) throw new Error('no events for 1');
        return [{ event: 'go', expected: true }];
      },
      ingest(cell) {
        cell.value = 1;
      },
      receive() {},
    });
    await expect(check(system({ a: broken }))).rejects.toThrow(new SystemError('"a"\'s events threw: no events for 1'));
  });

  it('a harness error a kind recorded between steps is raised at the system\'s next step, whichever part it is', async () => {
    const recorded: { fault: SystemError | undefined } = { fault: undefined };
    const faulty = { ...offering({ a: [{ event: 'tick', expected: true, to: 'b' }] }), fault: () => recorded.fault };
    const model = system({ a: faulty, b: pinger('a', 2) });
    expect(await model.getEvents(model.initialState)).toHaveLength(2);
    recorded.fault = new SystemError('a timer fired after the step');
    await expect(check(model)).rejects.toThrow(recorded.fault);
  });

  it('after a harness error the search of that model is over: every later call meets it', async () => {
    const model = system({ a: pinger('nobody', 1) });
    await expect(check(model)).rejects.toThrow(SystemError);
    await expect(check(model)).rejects.toThrow(SystemError);
  });
});

describe('system: the candidates', () => {
  it('what the parts expect comes first, in part order, then the rest; costs pass through', async () => {
    const model = system({
      a: offering({ a: [{ event: 'x' }, { event: 'y', expected: true, cost: ['k'] }] }),
      b: offering({ a: [{ event: 'z', expected: true }, { event: 'w', cost: ['k', 'k'] }] }),
    });
    expect(await eventsOf(model, model.initialState)).toEqual([
      { part: 'a', event: 'y', cost: ['k'] },
      { part: 'b', event: 'z' },
      { part: 'a', event: 'x' },
      { part: 'b', event: 'w', cost: ['k', 'k'] },
    ]);
  });

  it('where nothing is expected, each active part\'s first event is a candidate', async () => {
    const model = system({
      a: offering({ a: [{ event: 'p' }, { event: 'q' }] }),
      b: offering({}),
      c: offering({ a: [{ event: 'r' }] }),
    });
    expect(await eventsOf(model, model.initialState)).toEqual([
      { part: 'a', event: 'p' },
      { part: 'c', event: 'r' },
      { part: 'a', event: 'q' },
    ]);
  });

  it('part order is the order named, then the parts that came to exist, by id', async () => {
    const model = system(
      { z: pinger('b-2', 1), a: pinger('a-1', 1) },
      { kindOf: () => offering({ a: [{ event: 'tick', expected: true, to: 'b' }] }) },
    );
    const { to } = (await model.applyEvent(model.initialState, { part: 'z', event: 'ping' })) as { to: SystemState };
    const { to: next } = (await model.applyEvent(to, { part: 'a', event: 'ping' })) as { to: SystemState };
    expect((await eventsOf(model, next)).map((event) => event.part)).toEqual(['a-1', 'b-2']);
    expect(model.describeState?.(next)).toBe('z: {"sent":1,"got":0}; a: {"sent":1,"got":0}; a-1: a; b-2: a');
  });
});

describe('system: the rebuild check', () => {
  /** A part whose runtime keeps a count of its own, outside the value. */
  const leaky = {
    initial: () => 0,
    events: (value: number) => (value < 3 ? [{ event: 'go', expected: true }] : []),
    restore: () => ({ value: 0, hidden: 0 }),
    ingest(runtime: { value: number; hidden: number }) {
      runtime.hidden++;
      runtime.value = runtime.value + runtime.hidden;
    },
    receive() {},
    snapshot: (runtime: { value: number; hidden: number }) => runtime.value,
  };
  // `restore` ignores the value: the leak is what the check is for.
  const kind = { ...leaky, restore: (_id: string, value: number) => ({ value, hidden: 0 }) };

  it('a step that resumed a live runtime is run again from the values, and a difference is a SystemError', async () => {
    await expect(check(system({ a: kind }))).rejects.toThrow(/the rebuild check failed on "a"'s event go: "a" is 3 live, and 2 rebuilt\. State lived outside a value/);
  });

  it('is off with rebuildCheck: false', async () => {
    const space = await check(system({ a: kind }, { rebuildCheck: false }));
    expect(space.exhaustive).toBe(true);
  });
});

describe('system: the properties and the report', () => {
  it('ends and invariant see the parts\' values by id, and a throw is the violation', async () => {
    const model = system(
      { a: pinger('b', 2), b: pinger('a', 0) },
      {
        invariant: ({ b }) => (b.got > 1 ? { error: new Error('b heard too much') } : undefined),
      },
    );
    const error = await check(model).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViolationError);
    expect((error as ViolationError).message.split('\n')).toEqual([
      'b heard too much',
      '0 deviations, 2 steps',
      '  1. a: ping',
      '  2. a: ping',
      'in state: a: {"sent":2,"got":0}; b: {"sent":0,"got":2}',
    ]);
    const ends = system({ a: pinger('b', 1), b: pinger('a', 0) }, { ends: ({ a }) => expect(a.got).toBe(1) });
    await expect(check(ends)).rejects.toThrow(/expected \+0 to be 1/);
  });

  it('a kind\'s describers name its events and values; without them the values are shown as they are', async () => {
    const named = valuePart<number, 'tick'>({
      initial: () => 0,
      events: (value) => (value < 1 ? [{ event: 'tick', expected: true }] : []),
      ingest(cell) {
        cell.value++;
      },
      receive() {},
      describeEvent: (event, value, id) => `${id} ${event}s at ${value}`,
      describeValue: (value, id) => `${id} ticked ${value}`,
    });
    const model = system({ clock: named, other: offering({}) }, { ends: () => ({ error: new Error('no') }) });
    const error = await check(model).catch((e: unknown) => e);
    expect((error as ViolationError).message.split('\n')).toEqual(['no', '0 deviations, 1 step', '  1. clock ticks at 0', 'in state: clock: clock ticked 1; other: a']);
  });

  it('partsOf gives the values of a state', async () => {
    const model = system({ a: pinger('b', 1), b: pinger('a', 0) });
    expect(Object.fromEntries(partsOf(model.initialState).entries())).toEqual({ a: { sent: 0, got: 0 }, b: { sent: 0, got: 0 } });
  });
});

// ---------------------------------------------------------------------------
// The differential oracle: random systems of value parts, against the
// product written straight from the rules. The eager product knows
// nothing of restoring, the active set or the touched set: a state is
// every part's state, an event is applied at once, and what a part sends
// is a queue delivered in the order sent, a receiver's sends joining the
// end (D40). A receive sends only to parts later in the order, so that a
// step ends.
// ---------------------------------------------------------------------------

/** A seeded random stream (mulberry32): the same seed, the same systems. */
function random(seed: number) {
  let s = seed | 0;
  const next = (): number => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { int: (n: number) => Math.floor(next() * n), chance: (p: number) => next() < p };
}

interface EventSpec {
  to: number;
  expected: boolean;
  cost: string[];
  sends: { peer: number; message: number }[];
}
interface PartSpec {
  /** Per state, the events it offers. */
  events: EventSpec[][];
  /** Per state and message, the state a received message leads to, and what
   *  it sends on, only to parts later in the order, so a step ends; absent
   *  means ignored. */
  receives: Record<string, { to: number; sends: { peer: number; message: number }[] }>;
}
interface SystemSpec {
  parts: PartSpec[];
  /** Fail the invariant: part 0 at `bad[0]` and part 1 at `bad[1]`. */
  bad: [number, number] | null;
  /** Fail where the system stops with an odd sum of states. */
  oddEndIsBad: boolean;
}

function randomSpec(r: ReturnType<typeof random>): SystemSpec {
  const n = 2 + r.int(3);
  const parts: PartSpec[] = [];
  for (let i = 0; i < n; i++) {
    const states = 1 + r.int(3);
    const events: EventSpec[][] = [];
    const receives: PartSpec['receives'] = {};
    for (let s = 0; s < states; s++) {
      events.push(
        Array.from({ length: r.int(3) }, () => ({
          to: r.int(states),
          expected: r.chance(0.4),
          cost: r.chance(0.3) ? ['k'] : [],
          sends: Array.from({ length: r.int(3) }, () => ({ peer: r.int(n), message: r.int(2) })),
        })),
      );
      for (let m = 0; m < 2; m++) {
        if (!r.chance(0.7)) continue;
        const later = n - i - 1;
        receives[`${s}:${m}`] = {
          to: r.int(states),
          sends: later === 0 ? [] : Array.from({ length: r.int(3) }, () => ({ peer: i + 1 + r.int(later), message: r.int(2) })),
        };
      }
    }
    parts.push({ events, receives });
  }
  return { parts, bad: r.chance(0.5) ? [r.int(parts[0]!.events.length), r.int(parts[1]!.events.length)] : null, oddEndIsBad: r.chance(0.5) };
}

const partId = (i: number) => `p${i}`;

function toSystem(spec: SystemSpec): Model<SystemState, SystemEvent> {
  const kinds = Object.fromEntries(
    spec.parts.map((part, i): [string, ReturnType<typeof valuePart<number, number>>] => [
      partId(i),
      valuePart<number, number>({
        initial: () => 0,
        events: (value) => part.events[value]!.map((event, k) => ({ event: k, expected: event.expected, cost: event.cost })),
        ingest(cell, k, step) {
          const event = part.events[cell.value]![k]!;
          cell.value = event.to;
          for (const { peer, message } of event.sends) step.send(partId(peer), message);
        },
        receive(cell, _from, message, step) {
          const on = part.receives[`${cell.value}:${message as number}`];
          if (on === undefined) return;
          cell.value = on.to;
          for (const { peer, message: next } of on.sends) step.send(partId(peer), next);
        },
      }),
    ]),
  );
  const tuple = (values: Record<string, unknown>) => spec.parts.map((_, i) => values[partId(i)] as number);
  return system(kinds, {
    ...(spec.bad === null ? {} : { invariant: (values) => (deepEqual(tuple(values).slice(0, 2), spec.bad) ? { error: 'bad' } : undefined) }),
    ...(spec.oddEndIsBad ? { ends: (values) => (tuple(values).reduce((a, b) => a + b, 0) % 2 === 1 ? { error: 'odd end' } : undefined) } : {}),
  });
}

type Tuple = number[];
function toEager(spec: SystemSpec): Model<Tuple, { part: number; k: number }> {
  return {
    initialState: spec.parts.map(() => 0),
    getEvents(tuple) {
      const offers = spec.parts.flatMap((part, i) => part.events[tuple[i]!]!.map((event, k) => ({ part: i, k, expected: event.expected, cost: event.cost })));
      let candidates = offers.filter((offer) => offer.expected);
      if (candidates.length === 0) candidates = offers.filter((offer, at) => offers.findIndex((other) => other.part === offer.part) === at);
      const rest = offers.filter((offer) => !candidates.includes(offer));
      return [...candidates, ...rest].map(({ part, k, cost }) => ({ event: { part, k }, cost }));
    },
    applyEvent(tuple, { part, k }) {
      const next = [...tuple];
      const event = spec.parts[part]!.events[tuple[part]!]![k]!;
      next[part] = event.to;
      // The mail: what a part sends is delivered after its work, in the order sent, and what a receiver sends joins the end.
      const mail = [...event.sends];
      for (let item = mail.shift(); item !== undefined; item = mail.shift()) {
        const on = spec.parts[item.peer]!.receives[`${next[item.peer]!}:${item.message}`];
        if (on === undefined) continue;
        next[item.peer] = on.to;
        mail.push(...on.sends);
      }
      return { to: next };
    },
    ...(spec.bad === null ? {} : { invariant: (tuple) => (deepEqual(tuple.slice(0, 2), spec.bad) ? { error: 'bad' } : undefined) }),
    ...(spec.oddEndIsBad ? { terminalInvariant: (tuple) => (tuple.reduce((a, b) => a + b, 0) % 2 === 1 ? { error: 'odd end' } : undefined) } : {}),
  };
}

const costKey = (cost: CostVector) => JSON.stringify([...cost.entries()].sort());
const frontier = (costs: Iterable<[unknown, CostVector[]]>, project: (state: unknown) => Tuple) =>
  new Map([...costs].map(([state, list]) => [JSON.stringify(project(state)), list.map(costKey).sort()]));

describe('system against the eager product', () => {
  it(`agrees on ${RUNS} random systems (FUZZ_SEED=${SEED})`, async () => {
    const r = random(SEED);
    for (let run = 0; run < RUNS; run++) {
      const spec = randomSpec(r);
      const maxDeviations = r.int(4);
      const baseBudget: Record<string, number> = r.chance(0.5) ? { __steps__: 2 + r.int(6) } : {};
      const options = { maxDeviations, baseBudget, maxEdges: 2000 };
      const fromSystem = await exploreIteratively(toSystem(spec), options);
      const eager = await exploreIteratively(toEager(spec), options);
      const describe = `run ${run}: ${JSON.stringify(spec)} at ${JSON.stringify(options)}`;
      const projectSystem = (state: unknown) => spec.parts.map((_, i) => partsOf(state as SystemState).get(partId(i)) as number);
      expect(fromSystem.completed, describe).toBe(eager.completed);
      expect(fromSystem.exhaustive, describe).toBe(eager.exhaustive);
      expect(fromSystem.maxDeviationsReached, describe).toBe(eager.maxDeviationsReached);
      expect(frontier(fromSystem.costs.entries(), projectSystem), describe).toEqual(frontier(eager.costs.entries(), (tuple) => tuple as Tuple));
      expect(fromSystem.violation === null, describe).toBe(eager.violation === null);
      if (fromSystem.violation !== null && eager.violation !== null) {
        expect(costKey(fromSystem.violation.cost), describe).toBe(costKey(eager.violation.cost));
        expect(
          fromSystem.violation.steps.map((step) => [projectSystem(step.state), step.index, step.event.part, step.event.event]),
          describe,
        ).toEqual(eager.violation.steps.map((step) => [step.state, step.index, partId(step.event.part), step.event.k]));
      }
    }
  }, 120_000);
});
