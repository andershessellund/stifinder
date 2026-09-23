// ---------------------------------------------------------------------------
// stifinder against a brute-force oracle, on random models.
//
// The oracle knows nothing of caches, levels, deferral or dominance: it is a
// breadth-first search over (state, cost) pairs, straight from the model. It
// checks what the README promises: the violation reported is the least by
// (deviations, other cost, steps), its trace is a real path with the right
// indexes and costs, `costs` is the Pareto frontier within the budget, and
// `exhaustive` without a violation is a proof. It checks them after any
// history of calls on one cache, too: budgets up and down, runs cut short,
// callbacks that throw.
//
// The models are seeded, so a failure reproduces. To run more, or others:
//
//     FUZZ_RUNS=20000 FUZZ_SEED=7 pnpm test oracle
// ---------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import {
  type BudgetLike,
  type CacheAnalysis,
  type Model,
  type ViolationPath,
  DEVIATIONS_KEY,
  StateSpaceCache,
  analyzeCache,
  explore,
  exploreIteratively,
  shortestViolation,
} from './index.js';

const RUNS = Number(process.env.FUZZ_RUNS ?? 300);
const SEED = Number(process.env.FUZZ_SEED ?? 1);

/** A seeded random stream (mulberry32): the same seed, the same models. */
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
type Random = ReturnType<typeof random>;

// ---------------------------------------------------------------------------
// Random models
// ---------------------------------------------------------------------------

/** States are 0..n-1, 0 initial. An event leads to a state, or, where `to` is
 *  a string, is an error from `applyEvent`. Costs are units of `x` and `y`. */
interface Spec {
  events: { name: string; cost: string[]; to: number | string }[][];
  /** Fail `invariant`, when the model has one. */
  bad: number[];
  /** Fail `terminalInvariant` where they have no events, when the model has one. */
  badEnd: number[];
  /** Their `getEvents` throws. */
  broken: number[];
  invariant: boolean;
  terminalInvariant: boolean;
}

function randomSpec(r: Random, withBroken = false): Spec {
  const n = 2 + r.int(7);
  const events: Spec['events'] = [];
  for (let s = 0; s < n; s++) {
    const list: Spec['events'][number] = [];
    for (let k = r.int(4); k > 0; k--) {
      const cost: string[] = [];
      for (const key of ['x', 'y']) for (let u = r.int(3); u > 0 && r.chance(0.4); u--) cost.push(key);
      list.push({ name: `e${list.length}`, cost, to: r.chance(0.15) ? `error ${s}.${list.length}` : r.int(n) });
    }
    events.push(list);
  }
  const pick = (p: number) => events.map((_, s) => s).filter(() => r.chance(p));
  return {
    events,
    bad: pick(0.1),
    badEnd: pick(0.3),
    broken: withBroken ? [1 + r.int(n - 1), ...pick(0.1)] : [],
    invariant: r.chance(0.5),
    terminalInvariant: r.chance(0.5),
  };
}

function toModel(spec: Spec): Model<number, string> {
  return {
    initialState: 0,
    getEvents(s) {
      if (spec.broken.includes(s)) throw new Error(`getEvents(${s}) is broken`);
      return spec.events[s]!.map(({ name, cost }) => ({ event: name, cost }));
    },
    applyEvent(s, name) {
      const { to } = spec.events[s]!.find((e) => e.name === name)!;
      return typeof to === 'string' ? { error: to } : { to };
    },
    ...(spec.invariant ? { invariant: (s: number) => (spec.bad.includes(s) ? { error: `bad ${s}` } : undefined) } : {}),
    ...(spec.terminalInvariant
      ? { terminalInvariant: (s: number) => (spec.badEnd.includes(s) ? { error: `stuck ${s}` } : undefined) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------

type Cost = { dev: number; x: number; y: number };
type Rank = [devs: number, sum: number, steps: number];

/** Reaching a state: fine, a violation (the state is bad), or a throw. */
function arrive(spec: Spec, s: number): 'fine' | 'throws' | { error: string } {
  if (spec.invariant && spec.bad.includes(s)) return { error: `bad ${s}` };
  if (spec.broken.includes(s)) return 'throws'; // its events are asked for next
  if (spec.terminalInvariant && spec.events[s]!.length === 0 && spec.badEnd.includes(s)) return { error: `stuck ${s}` };
  return 'fine';
}

const le = (a: Cost, b: Cost) => a.dev <= b.dev && a.x <= b.x && a.y <= b.y;
const same = (a: Cost, b: Cost) => a.dev === b.dev && a.x === b.x && a.y === b.y;
const sum = (c: Cost) => c.dev + c.x + c.y;
const less = (a: Rank, b: Rank) => (a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2]);
const step = (c: Cost, cost: string[], index: number): Cost => ({
  dev: c.dev + (index > 0 ? 1 : 0),
  x: c.x + cost.filter((k) => k === 'x').length,
  y: c.y + cost.filter((k) => k === 'y').length,
});

/** A budget that covers every simple path, and so every Pareto-minimal cost
 *  and the least violation: what an unbounded budget sees. */
const unbounded = (spec: Spec): Cost => {
  const n = spec.events.length;
  return { dev: n + 1, x: 2 * n + 2, y: 2 * n + 2 };
};

interface Truth {
  /** Some state reached within the budget throws. */
  throws: boolean;
  /** The rank of the least violation within the budget. */
  rank: Rank | null;
  /** Pareto-minimal costs per state reached within the budget. */
  frontier: Map<number, Cost[]>;
}

function oracle(spec: Spec, budget: Cost): Truth {
  const b = { ...budget, dev: Math.min(budget.dev, unbounded(spec).dev) };
  const zero: Cost = { dev: 0, x: 0, y: 0 };
  const frontier = new Map<number, Cost[]>();
  let rank: Rank | null = null;
  let throws = false;
  const consider = (r: Rank) => {
    if (rank === null || less(r, rank)) rank = r;
  };

  const start = arrive(spec, 0);
  if (start === 'throws') return { throws: true, rank, frontier };
  if (start !== 'fine') return { throws, rank: [0, 0, 0], frontier: new Map([[0, [zero]]]) };

  const seen = new Set(['0|0|0|0']);
  const queue: [number, Cost, number][] = [[0, zero, 0]];
  for (let qi = 0; qi < queue.length; qi++) {
    const [s, c, depth] = queue[qi]!;
    spec.events[s]!.forEach(({ cost, to }, index) => {
      const next = step(c, cost, index);
      if (!le(next, b)) return;
      if (typeof to === 'string') return consider([next.dev, sum(next), depth + 1]);
      const outcome = arrive(spec, to);
      if (outcome === 'throws') throws = true;
      else if (outcome !== 'fine') consider([next.dev, sum(next), depth + 1]);
      else if (!seen.has(`${to}|${next.dev}|${next.x}|${next.y}`)) {
        seen.add(`${to}|${next.dev}|${next.x}|${next.y}`);
        queue.push([to, next, depth + 1]);
      }
    });
  }
  for (const [s, c] of queue) frontier.set(s, [...(frontier.get(s) ?? []), c]);
  for (const [s, cs] of frontier) frontier.set(s, cs.filter((c) => !cs.some((o) => le(o, c) && !same(o, c))));
  return { throws, rank, frontier };
}

// ---------------------------------------------------------------------------
// Checking a result against it
// ---------------------------------------------------------------------------

const toCost = (v: ReadonlyMap<string, number>): Cost => ({ dev: v.get(DEVIATIONS_KEY) ?? 0, x: v.get('x') ?? 0, y: v.get('y') ?? 0 });
const toBudget = (c: Cost): BudgetLike => ({ [DEVIATIONS_KEY]: c.dev, x: c.x, y: c.y });
/** JSON for a failure message, with an unbounded budget spelled out (JSON would say null). */
const show = (value: unknown) => JSON.stringify(value, (_, v: unknown) => (v === Infinity ? 'Infinity' : v));
const describeFrontier = (f: Map<number, Cost[]>) =>
  [...f].map(([s, cs]) => `${s}: ${cs.map((c) => `${c.dev}/${c.x}/${c.y}`).sort().join(' ')}`).sort();

function randomBudget(r: Random): Cost {
  return { dev: r.chance(0.15) ? Infinity : r.int(4), x: r.int(3), y: r.int(3) };
}

/** `analysis` is what the oracle says holds at `budget`, and its traces are real. */
function expectAgrees(spec: Spec, budget: Cost, analysis: CacheAnalysis<number, string>, context: string): void {
  const where = `${context}; budget ${show(budget)}; model ${show(spec)}`;
  const truth = oracle(spec, budget);
  expect(describeFrontier(new Map([...analysis.costs].map(([s, cs]) => [s, cs.map(toCost)]))), where).toEqual(
    describeFrontier(truth.frontier),
  );
  // Both searches find a violation of the least rank (of several that tie,
  // not necessarily the same one), and a real trace to it.
  const found = { 'analysis.violation': analysis.violation, 'shortestViolation(analysis)': shortestViolation(analysis) };
  for (const [name, v] of Object.entries(found)) {
    expect(v === null ? null : [toCost(v.cost).dev, sum(toCost(v.cost)), v.steps.length], `${where}; ${name}`).toEqual(truth.rank);
    if (v !== null) expectReplays(spec, v, `${where}; ${name}`);
  }
}

/** `v` is a path in the model, with the indexes, costs, error and badState it claims. */
function expectReplays(spec: Spec, v: ViolationPath<number, string>, where: string): void {
  let s = 0;
  let c: Cost = { dev: 0, x: 0, y: 0 };
  let error: unknown = null;
  let badState: number | undefined;
  if (v.steps.length === 0) {
    const outcome = arrive(spec, 0);
    error = typeof outcome === 'object' ? outcome.error : null;
    badState = 0;
  }
  for (const [i, st] of v.steps.entries()) {
    expect([st.state, toCost(st.cost)], `${where}; step ${i}`).toEqual([s, c]);
    const event = spec.events[s]![st.index];
    expect(event?.name, `${where}; step ${i}`).toBe(st.event);
    c = step(c, event!.cost, st.index);
    if (i < v.steps.length - 1) {
      expect(typeof event!.to, `${where}; step ${i} leads on`).toBe('number');
      s = event!.to as number;
      expect(arrive(spec, s), `${where}; step ${i} leads on`).toBe('fine');
    } else if (typeof event!.to === 'string') {
      error = event!.to;
    } else {
      const outcome = arrive(spec, event!.to);
      error = typeof outcome === 'object' ? outcome.error : null;
      badState = event!.to;
    }
  }
  expect([v.error, v.badState, toCost(v.cost)], `${where}; the violation`).toEqual([error, badState, c]);
}

/** `exhaustive` is a proof: the projection is the whole state space. */
function expectProof(spec: Spec, analysis: CacheAnalysis<number, string>, context: string): void {
  expectAgrees(spec, unbounded(spec), analysis, `${context}, exhaustive`);
}

/** Up to four calls at random budgets, most of them cut short; throws are expected when `spec` has broken states. */
async function randomHistory(r: Random, cache: StateSpaceCache<number, string>): Promise<void> {
  for (let calls = r.int(5); calls > 0; calls--) {
    await explore(cache, toBudget(randomBudget(r)), { maxEdges: r.chance(0.7) ? 1 + r.int(4) : 1e6 }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------

describe('against a brute-force oracle, on random models', () => {
  it('reports the least violation, a real trace to it, and the Pareto costs', async () => {
    const r = random(SEED);
    for (let run = 0; run < RUNS; run++) {
      const spec = randomSpec(r);
      const cache = new StateSpaceCache(toModel(spec));
      const budget = randomBudget(r);
      const result = await explore(cache, toBudget(budget), { maxEdges: 1e6 });
      const analysis = analyzeCache(cache, toBudget(budget));
      expectAgrees(spec, budget, analysis, `run ${run}`);
      if (result.exhaustive) expectProof(spec, analysis, `run ${run}`);
      // A smaller budget is covered too.
      const smaller = { dev: r.int(Math.min(budget.dev, 5) + 1), x: r.int(budget.x + 1), y: r.int(budget.y + 1) };
      expectAgrees(spec, smaller, analyzeCache(cache, toBudget(smaller)), `run ${run}, smaller budget`);
    }
  });

  it('agrees after any history of calls on one cache: budgets up and down, runs cut short', async () => {
    const r = random(SEED + 1);
    for (let run = 0; run < RUNS; run++) {
      const spec = randomSpec(r);
      const cache = new StateSpaceCache(toModel(spec));
      await randomHistory(r, cache);
      const budget = randomBudget(r);
      const result = await explore(cache, toBudget(budget), { maxEdges: 1e6 });
      const analysis = analyzeCache(cache, toBudget(budget));
      expectAgrees(spec, budget, analysis, `run ${run}`);
      if (result.exhaustive) expectProof(spec, analysis, `run ${run}`);
    }
  });

  it('exploreIteratively stops at the first failing budget, or where no larger one could find more', async () => {
    const r = random(SEED + 2);
    for (let run = 0; run < RUNS; run++) {
      const spec = randomSpec(r);
      const cache = new StateSpaceCache(toModel(spec));
      if (r.chance(0.5)) await randomHistory(r, cache); // a kept cache
      const base = { x: r.int(3), y: r.int(3) };
      const maxDeviations = r.chance(0.2) ? Infinity : r.int(6);
      const stopOnViolation = r.chance(0.7);
      const space = await exploreIteratively(cache, { baseBudget: base, maxDeviations, stopOnViolation, maxEdges: 1e6 });
      const d = space.maxDeviationsReached;
      const context = `run ${run}: ${show({ base, maxDeviations, stopOnViolation, d })}`;

      expect(space.completed, context).toBe(true);
      expectAgrees(spec, { ...base, dev: d }, space, context);
      if (stopOnViolation && space.violation !== null) {
        // The first failing budget: none below it fails.
        if (d > 0) expect(oracle(spec, { ...base, dev: d - 1 }).rank, `${context}, one budget lower`).toBeNull();
      } else if (d < maxDeviations) {
        // Stopped short of maxDeviations: no number of deviations would add anything.
        expectAgrees(spec, { ...base, dev: Infinity }, space, `${context}, any deviations`);
      }
      if (space.exhaustive) expectProof(spec, space, context);
    }
  });

  it('a callback that throws rejects the call, and every later one that reaches it', async () => {
    const r = random(SEED + 3);
    for (let run = 0; run < RUNS; run++) {
      const spec = randomSpec(r, true);
      const cache = new StateSpaceCache(toModel(spec));
      await randomHistory(r, cache); // some calls reject
      const budget = randomBudget(r);
      const context = `run ${run}; budget ${show(budget)}; model ${show(spec)}`;
      const outcome = () =>
        explore(cache, toBudget(budget), { maxEdges: 1e6 }).then(
          (result) => result,
          () => 'rejected' as const,
        );
      const first = await outcome();
      if (oracle(spec, budget).throws) {
        expect(first, context).toBe('rejected');
        expect(await outcome(), `${context}, again`).toBe('rejected');
      } else {
        expect(first, context).not.toBe('rejected');
        const analysis = analyzeCache(cache, toBudget(budget));
        expectAgrees(spec, budget, analysis, context);
        if (first !== 'rejected' && first.exhaustive) expectProof(spec, analysis, context);
      }
    }
  });
});
