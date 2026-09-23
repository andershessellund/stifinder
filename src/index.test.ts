import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ApplyResult,
  type CacheAnalysis,
  type EventDescriptor,
  type ExplorerConfig,
  type Model,
  DEVIATIONS_KEY,
  StateSpaceCache,
  analyzeCache,
  explore,
  exploreIteratively,
  exploreOnce,
  shortestViolation,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface CoinState {
  heads: number;
  tossesRemaining: number;
}

type CoinEvent = { toss: 'heads' | 'tails' };

function makeConfig(
  initial: CoinState,
  throwIfHeadsReaches?: number,
  headsCost: readonly string[] = [],
): ExplorerConfig<CoinState, CoinEvent> {
  return {
    initialState: initial,
    async getEvents(state) {
      if (state.tossesRemaining <= 0) return [];
      const events: EventDescriptor<CoinEvent>[] = [
        { event: { toss: 'heads' }, cost: headsCost },
        { event: { toss: 'tails' }, cost: [] },
      ];
      return events;
    },
    async applyEvent(state, event) {
      const isHead = event.toss === 'heads';
      const next: CoinState = {
        heads: state.heads + (isHead ? 1 : 0),
        tossesRemaining: state.tossesRemaining - 1,
      };
      if (throwIfHeadsReaches !== undefined && next.heads >= throwIfHeadsReaches) {
        return { error: new Error('too many heads') };
      }
      return { to: next };
    },
  };
}

/** A tiny graph model: `edges[state]` lists `[event, cost, target]` in
 *  preference order; a string target starting with `!` is an error. */
type Edge = [event: string, cost: readonly string[], target: string];
function graph(initial: string, edges: Record<string, Edge[]>): ExplorerConfig<string, string> {
  return {
    initialState: initial,
    async getEvents(state) {
      return (edges[state] ?? []).map(([event, cost]) => ({ event, cost }));
    },
    async applyEvent(state, event) {
      const edge = (edges[state] ?? []).find(([e]) => e === event);
      if (edge === undefined) throw new Error(`no edge ${state} -${event}->`);
      const target = edge[2];
      return target.startsWith('!') ? { error: target.slice(1) } : { to: target };
    },
  };
}

/** The embedded violation and the transition-table recomputation must agree. */
function expectConsistent<State, Event>(analysis: CacheAnalysis<State, Event>): void {
  const recomputed = shortestViolation(analysis);
  if (analysis.violation === null) {
    expect(recomputed).toBeNull();
    return;
  }
  expect(recomputed).not.toBeNull();
  expect(recomputed!.error).toEqual(analysis.violation.error);
  expect(recomputed!.cost).toBe(analysis.violation.cost); // interned: equal vectors are identical
  expect(recomputed!.badState).toEqual(analysis.violation.badState);
  expect('badState' in recomputed!).toBe('badState' in analysis.violation);
  expect(recomputed!.steps.map((s) => [s.state, s.cost, s.event, s.index])).toEqual(
    analysis.violation.steps.map((s) => [s.state, s.cost, s.event, s.index]),
  );
}

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('exploreIteratively', () => {
  it('eventually covers the whole state space (no violations)', async () => {
    const cache = new StateSpaceCache(makeConfig({ heads: 0, tossesRemaining: 3 }));
    const space = await exploreIteratively(cache);

    // r=3: {0,3}; r=2: {0,2},{1,2}; r=1: {0,1},{1,1},{2,1}; r=0: 4 states. Total 10.
    expect(space.transitions.size).toBe(10);
    expect(space.costs.size).toBe(10);

    const finalStates = [...space.transitions.entries()].filter(
      ([s]) => s.tossesRemaining === 0,
    );
    expect(finalStates).toHaveLength(4);
    for (const [, list] of finalStates) {
      expect(list).toHaveLength(0);
    }

    expect(space.violation).toBeNull();
    expectConsistent(space);
    expect(space.maxDeviationsReached).toBeGreaterThanOrEqual(3);
    expect(space.exhaustive).toBe(true);
    expect(cache.pending.size).toBe(0);
    expect(cache.deferred).toHaveLength(0);
  });

  it('reports the shortest minimum-deviation violation', async () => {
    const cache = new StateSpaceCache(makeConfig({ heads: 0, tossesRemaining: 3 }, 2));
    const space = await exploreIteratively(cache);

    const violation = space.violation;
    expect(violation).not.toBeNull();

    expect(violation!.steps).toHaveLength(2);
    expect(violation!.steps[0]!.state).toEqual({ heads: 0, tossesRemaining: 3 });
    expect(violation!.steps[0]!.event).toEqual({ toss: 'heads' });
    expect(violation!.steps[1]!.state).toEqual({ heads: 1, tossesRemaining: 2 });
    expect(violation!.steps[1]!.event).toEqual({ toss: 'heads' });
    expect((violation!.error as Error).message).toBe('too many heads');
    expectConsistent(space);

    expect(space.maxDeviationsReached).toBe(0);
  });

  it('handles a terminal initial state with no events', async () => {
    const cache = new StateSpaceCache(makeConfig({ heads: 0, tossesRemaining: 0 }));
    const space = await exploreIteratively(cache);

    expect(space.transitions.size).toBe(1);
    expect(space.transitions.get({ heads: 0, tossesRemaining: 0 })).toEqual([]);
    expect(space.violation).toBeNull();
  });

  it('reproduces the README example', async () => {
    const space = await exploreIteratively<{ a: number; b: number }, string>({
      initialState: { a: 0, b: 0 },
      getEvents(s) {
        if (s.a + s.b >= 6) return [];
        return s.a > s.b ? [{ event: 'tick-b' }, { event: 'tick-a' }] : [{ event: 'tick-a' }, { event: 'tick-b' }];
      },
      applyEvent(s, e) {
        const next = e === 'tick-a' ? { ...s, a: s.a + 1 } : { ...s, b: s.b + 1 };
        if (next.a - next.b > 2) return { error: new Error('a ran too far ahead') };
        return { to: next };
      },
    });
    expect(space.violation?.steps.map((s) => s.event)).toEqual(['tick-a', 'tick-a', 'tick-a']);
    expect(space.violation?.steps.map((s) => s.index)).toEqual([0, 1, 1]);
    expect(space.maxDeviationsReached).toBe(2);
    expectConsistent(space);
  });

  it('stopOnViolation: false keeps deepening after the first failing budget', async () => {
    const cache = new StateSpaceCache(makeConfig({ heads: 0, tossesRemaining: 3 }, 2));
    const space = await exploreIteratively(cache, { stopOnViolation: false });
    expect(space.maxDeviationsReached).toBe(3);
    expect(cache.pending.size).toBe(0);
    // The reported violation is still the cheapest one.
    expect(space.violation!.steps).toHaveLength(2);
    expectConsistent(space);
  });

  it('terminates on cyclic state spaces', async () => {
    const cache = new StateSpaceCache(
      graph('0', {
        '0': [['next', [], '1'], ['reset', [], '0']],
        '1': [['next', [], '2'], ['reset', [], '0']],
        '2': [['next', [], '0'], ['reset', [], '0']],
      }),
    );
    const space = await exploreIteratively(cache);
    expect(space.costs.size).toBe(3);
    expect(space.violation).toBeNull();
    expect(cache.pending.size).toBe(0);
    expect(space.maxDeviationsReached).toBe(1);
  });

  it('treats a thrown applyEvent as an error result', async () => {
    const config = makeConfig({ heads: 0, tossesRemaining: 2 });
    const throwing: ExplorerConfig<CoinState, CoinEvent> = {
      ...config,
      async applyEvent(state, event) {
        if (event.toss === 'tails') throw new Error('tails is broken');
        return config.applyEvent(state, event);
      },
    };
    const space = await exploreIteratively(new StateSpaceCache(throwing));
    expect((space.violation!.error as Error).message).toBe('tails is broken');
    expect(space.maxDeviationsReached).toBe(1);
    expectConsistent(space);
  });

  it('returns the canonical initial state, identical to its key in costs', async () => {
    const space = await exploreIteratively(new StateSpaceCache(makeConfig({ heads: 0, tossesRemaining: 1 })));
    expect([...space.costs.keys()].some((k) => k === space.initialState)).toBe(true);
    expect(space.costs.get(space.initialState)).toHaveLength(1);
  });
});

describe('budgets and deviations', () => {
  it('category budget limits reachable states', async () => {
    const cache = new StateSpaceCache(
      makeConfig({ heads: 0, tossesRemaining: 3 }, undefined, ['headsBudget']),
    );
    const space = await exploreIteratively(cache, { baseBudget: { headsBudget: 1 } });

    const allStates = [...space.transitions.keys()];
    expect(allStates.every((s) => s.heads <= 1)).toBe(true);
    expect(space.transitions.size).toBe(7);
    expect(space.violation).toBeNull();
  });

  it('detects violations on budget-constrained events', async () => {
    const cache = new StateSpaceCache(
      makeConfig({ heads: 0, tossesRemaining: 3 }, 2, ['headsBudget']),
    );
    const space = await exploreIteratively(cache, { baseBudget: { headsBudget: 2 } });

    expect(space.violation).not.toBeNull();
    expect((space.violation!.error as Error).message).toBe('too many heads');
    expectConsistent(space);
  });

  it('preferred event costs no deviation; non-preferred events cost one each', async () => {
    const config = makeConfig({ heads: 0, tossesRemaining: 1 });

    const d0 = await exploreIteratively(new StateSpaceCache(config), { maxDeviations: 0 });
    expect(d0.transitions.size).toBe(2);
    const tossed0 = [...d0.transitions.keys()].filter((s) => s.tossesRemaining === 0);
    expect(tossed0).toEqual([{ heads: 1, tossesRemaining: 0 }]);

    const d1 = await exploreIteratively(new StateSpaceCache(config), { maxDeviations: 1 });
    const tossed1 = [...d1.transitions.keys()].filter((s) => s.tossesRemaining === 0);
    expect(tossed1).toHaveLength(2);
  });

  it('reserved __deviations__ key in baseBudget is overridden', async () => {
    const config = makeConfig({ heads: 0, tossesRemaining: 1 });
    const space = await exploreIteratively(new StateSpaceCache(config), {
      baseBudget: { [DEVIATIONS_KEY]: 999 } as Record<string, number>,
      maxDeviations: 0,
    });
    const tossed = [...space.transitions.keys()].filter((s) => s.tossesRemaining === 0);
    expect(tossed).toEqual([{ heads: 1, tossesRemaining: 0 }]);
  });

  it('rejects the reserved __deviations__ key in event costs', async () => {
    const cache = new StateSpaceCache(graph('a', { a: [['e', [DEVIATIONS_KEY], 'b']] }));
    await expect(explore(cache, {})).rejects.toThrow(DEVIATIONS_KEY);
  });

  it('an unbounded deviation budget ends where the deviation levels do', async () => {
    const cache = new StateSpaceCache(graph('0', { '0': [['a', [], '1'], ['b', [], '2']], '1': [['c', [], '2']] }));
    expect(await explore(cache, { [DEVIATIONS_KEY]: Infinity })).toMatchObject({ completed: true, exhaustive: true });
    expect(analyzeCache(cache, { [DEVIATIONS_KEY]: Infinity }).costs.size).toBe(3);
  });

  it('charges a cost key once per occurrence', async () => {
    const config = graph('a', { a: [['e', ['x', 'x'], '!boom']] });
    const one = await exploreOnce(config, { x: 1 });
    expect(one.violation).toBeNull();
    expectConsistent(one);
    const two = await exploreOnce(config, { x: 2 });
    expect(two.violation).not.toBeNull();
    expectConsistent(two);
  });

  it('lists Pareto-minimal costs per state and prunes dominated ones', async () => {
    // b is reached at {x:1} (preferred) and at {dev:1} (deviation): incomparable.
    const cache = new StateSpaceCache(
      graph('a', { a: [['p', ['x'], 'b'], ['q', [], 'b']], b: [['r', [], 'c']] }),
    );
    await explore(cache, { x: 1, [DEVIATIONS_KEY]: 1 });
    const both = analyzeCache(cache, { x: 1, [DEVIATIONS_KEY]: 1 });
    expect(both.costs.get('b')).toHaveLength(2);
    expect(both.costs.get('c')).toHaveLength(2);
    const noDev = analyzeCache(cache, { x: 1, [DEVIATIONS_KEY]: 0 });
    expect(noDev.costs.get('b')).toHaveLength(1);
    expect(noDev.costs.get('b')![0]!.get('x')).toBe(1);
    // r out of b was computed once and hit the cache the second time.
    expect(cache.edgesComputed).toBe(3);
    expect(cache.applyEventCacheHits).toBe(1);
  });
});

describe('explore (single budget)', () => {
  it('runs one BFS at a fixed budget and reports edgesAddedThisRun', async () => {
    const cache = new StateSpaceCache(makeConfig({ heads: 0, tossesRemaining: 2 }));
    const r0 = await explore(cache, { [DEVIATIONS_KEY]: 0 });
    // Preferred-only path: {0,2} -> heads -> {1,1} -> heads -> {2,0}
    expect(r0.completed).toBe(true);
    expect(cache.errorEdges).toHaveLength(0);
    expect(r0.edgesAddedThisRun).toBe(2);
    expect(r0.edgesComputed).toBe(2);

    // Re-run with deeper budget; new edges added on top of cache.
    const r1 = await explore(cache, { [DEVIATIONS_KEY]: 1 });
    expect(r1.completed).toBe(true);
    expect(r1.edgesComputed).toBe(cache.edgesComputed);
    expect(r1.edgesAddedThisRun).toBeGreaterThan(0);
  });

  it('shares cache across calls — second call adds zero edges if subspace already computed', async () => {
    const cache = new StateSpaceCache(makeConfig({ heads: 0, tossesRemaining: 1 }));
    const r0 = await explore(cache, { [DEVIATIONS_KEY]: 0 });
    expect(r0.edgesAddedThisRun).toBe(1);
    const r0again = await explore(cache, { [DEVIATIONS_KEY]: 0 });
    expect(r0again.edgesAddedThisRun).toBe(0);
    expect(r0again.edgesComputed).toBe(1);
  });

  it('exploreOnce constructs and discards a cache', async () => {
    const r = await exploreOnce(makeConfig({ heads: 0, tossesRemaining: 1 }), { [DEVIATIONS_KEY]: 1 });
    expect(r.completed).toBe(true);
    expect(r.violation).toBeNull();
    expect(r.transitions.size).toBe(3);
  });

  it('traverses edges deferred under a small budget once the budget grows', async () => {
    const chain = graph('0', { '0': [['x', ['x'], '1']], '1': [['x', ['x'], '2']], '2': [['x', ['x'], '!boom']] });
    const cache = new StateSpaceCache(chain);
    await explore(cache, { x: 1 });
    expect(cache.deferred).toHaveLength(1);
    await explore(cache, { x: 0 });
    expect(analyzeCache(cache, { x: 5 }).violation).toBeNull();
    await explore(cache, { x: 5 });
    expect(cache.deferred).toHaveLength(0);
    const analysis = analyzeCache(cache, { x: 5 });
    expect(analysis.violation!.steps).toHaveLength(3);
    expectConsistent(analysis);
  });

  it('rejects a concurrent explore on the same cache', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const cache = new StateSpaceCache<string, string>({
      initialState: 'a',
      async getEvents(s) { return s === 'a' ? [{ event: 'e', cost: [] }] : []; },
      async applyEvent() { await gate; return { to: 'b' }; },
    });
    const first = explore(cache, {});
    await expect(explore(cache, {})).rejects.toThrow(/in flight/);
    release();
    expect((await first).completed).toBe(true);
    // The guard is released afterwards.
    expect((await explore(cache, {})).completed).toBe(true);
  });
});

describe('limits', () => {
  it('maxEdges caps applyEvent calls per explore call', async () => {
    const chain = graph('0', { '0': [['n', [], '1']], '1': [['n', [], '2']], '2': [['n', [], '3']] });
    const cache = new StateSpaceCache(chain);
    const r1 = await explore(cache, {}, { maxEdges: 1 });
    expect([r1.completed, r1.edgesAddedThisRun]).toEqual([false, 1]);
    const r2 = await explore(cache, {}, { maxEdges: 1 });
    expect([r2.completed, r2.edgesAddedThisRun]).toEqual([false, 1]);
    const r3 = await explore(cache, {}, { maxEdges: 1 });
    expect([r3.completed, r3.edgesAddedThisRun, r3.edgesComputed]).toEqual([true, 1, 3]);
  });

  it('maxEdges does not count cache hits', async () => {
    const cache = new StateSpaceCache(
      graph('a', { a: [['p', ['x'], 'b'], ['q', [], 'b']], b: [['r', [], 'c']] }),
    );
    // Three distinct edges; the fourth traversal (r from b's second arrival) is a hit.
    const r = await explore(cache, { x: 1, [DEVIATIONS_KEY]: 1 }, { maxEdges: 3 });
    expect(r.completed).toBe(true);
    expect(cache.edgesComputed).toBe(3);
    expect(cache.applyEventCacheHits).toBe(1);
  });

  it('maxEdges caps the whole iterative run and reports where it stopped', async () => {
    const cache = new StateSpaceCache(makeConfig({ heads: 0, tossesRemaining: 3 }));
    const space = await exploreIteratively(cache, { maxEdges: 4 });
    expect(space.completed).toBe(false);
    expect(space.timedOut).toBe(false);
    expect(space.edgesComputed).toBe(4);
    expect(space.exhaustive).toBe(false);
    // Budget 0 needs 3 edges and completes; budget 1 runs out.
    expect(space.maxDeviationsReached).toBe(0);
    expect(space.budget.get(DEVIATIONS_KEY)).toBe(1);
  });

  it('timeoutMs bounds the whole iterative run, not each iteration', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let calls = 0;
    const cache = new StateSpaceCache(makeConfig({ heads: 0, tossesRemaining: 3 }));
    const slow: ExplorerConfig<CoinState, CoinEvent> = {
      ...cache.model,
      async applyEvent(state, event) {
        calls++;
        vi.advanceTimersByTime(4);
        return cache.model.applyEvent(state, event);
      },
    };
    const space = await exploreIteratively(new StateSpaceCache(slow), { timeoutMs: 10 });
    // Budget 0 takes three edges (12ms) and completes; budget 1 is past the deadline before its first edge.
    expect(calls).toBe(3);
    expect(space.timedOut).toBe(true);
    expect(space.completed).toBe(false);
    expect(space.maxDeviationsReached).toBe(0);
  });

  it('resumes after a timeout without losing pending edges', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const config = makeConfig({ heads: 0, tossesRemaining: 3 });
    const slow: ExplorerConfig<CoinState, CoinEvent> = {
      ...config,
      async applyEvent(state, event) {
        vi.advanceTimersByTime(4);
        return config.applyEvent(state, event);
      },
    };
    const cache = new StateSpaceCache(slow);
    const r1 = await explore(cache, { [DEVIATIONS_KEY]: 3 }, { timeoutMs: 5 });
    expect(r1.timedOut).toBe(true);
    const r2 = await explore(cache, { [DEVIATIONS_KEY]: 3 });
    expect(r2.completed).toBe(true);
    expect(analyzeCache(cache, { [DEVIATIONS_KEY]: 3 }).costs.size).toBe(10);
  });
});

describe('a callback that throws', () => {
  // A pure model that throws throws again: the next call on the cache must
  // meet the same throw, not find the edge gone and call the search complete.

  it('rejects the call, and the next one, at the initial state', async () => {
    const cache = new StateSpaceCache<string, string>({
      initialState: 'start',
      getEvents(state) {
        if (state === 'start') throw new Error('no events for start');
        return [];
      },
      applyEvent: () => ({ error: 'unreachable' }),
    });
    await expect(explore(cache, {})).rejects.toThrow('no events for start');
    await expect(explore(cache, { [DEVIATIONS_KEY]: 5 })).rejects.toThrow('no events for start');
    expect(cache.exhaustive).toBe(false);
  });

  it('mid-run, leaves the edge it interrupted, and the ones after it, to be tried again', async () => {
    // `b` and `c` are traversed together, as one deviation at depth one; B throws.
    const model = graph('0', { '0': [['a', [], 'A'], ['b', [], 'B'], ['c', [], 'C']], C: [['crash', [], '!crash']] });
    const cache = new StateSpaceCache<string, string>({
      ...model,
      getEvents(state) {
        if (state === 'B') throw new Error('no events for B');
        return model.getEvents(state);
      },
    });
    await expect(explore(cache, { [DEVIATIONS_KEY]: 1 })).rejects.toThrow('no events for B');
    await expect(exploreIteratively(cache)).rejects.toThrow('no events for B');
    expect(cache.exhaustive).toBe(false);
  });

  it('so does a successor state that valsem cannot intern', async () => {
    const cache = new StateSpaceCache<unknown, string>({
      initialState: 0,
      getEvents: (state) => (state === 0 ? [{ event: 'go' }] : []),
      applyEvent: () => ({ to: { at: new Date(0) } }),
    });
    await expect(explore(cache, {})).rejects.toThrow(/Date/);
    await expect(explore(cache, {})).rejects.toThrow(/Date/);
  });
});

describe('regressions', () => {
  it('reusing a cache across non-monotone budgets does not lose deferred edges', async () => {
    const config = graph('root', {
      root: [['p', ['x'], 'P'], ['q', ['x'], 'Q']],
      P: [['p2', ['x'], '!p2']],
      Q: [['q2', ['x'], '!q2']],
    });
    const cache = new StateSpaceCache(config);
    await explore(cache, { x: 2, [DEVIATIONS_KEY]: 0 }); // root-p->P-p2->error; q waits at deviation level 1
    await explore(cache, { x: 1, [DEVIATIONS_KEY]: 1 }); // root-q->Q; Q-q2 needs x=2: deferred under x=1
    await explore(cache, { x: 2, [DEVIATIONS_KEY]: 1 }); // x=2 again: q2 must be revived
    const reused = analyzeCache(cache, { x: 2, [DEVIATIONS_KEY]: 1 });

    const fresh = new StateSpaceCache(config);
    await explore(fresh, { x: 2, [DEVIATIONS_KEY]: 1 });
    const direct = analyzeCache(fresh, { x: 2, [DEVIATIONS_KEY]: 1 });

    expect(cache.errorEdges.map((e) => e.event).sort()).toEqual(['p2', 'q2']);
    expect(cache.deferred).toHaveLength(0);
    expect(reused.costs.size).toBe(direct.costs.size);
    expect(reused.transitions.get('Q')).toEqual(direct.transitions.get('Q'));
  });

  it('shortestViolation(analysis) charges deviations by the original event index', async () => {
    // Index 0 needs a key never in the budget; index 1 is free, a deviation, and fails.
    const cache = new StateSpaceCache(
      graph('a', { a: [['locked', ['k'], 'b'], ['dev', [], '!devbad']] }),
    );
    await explore(cache, { [DEVIATIONS_KEY]: 1 });

    const atZero = analyzeCache(cache, { [DEVIATIONS_KEY]: 0 });
    expect(atZero.violation).toBeNull();
    expect(atZero.transitions.get('a')).toEqual([{ event: 'dev', index: 1, cost: [], error: 'devbad' }]);
    expectConsistent(atZero);

    const atOne = analyzeCache(cache, { [DEVIATIONS_KEY]: 1 });
    expect(atOne.violation).not.toBeNull();
    expectConsistent(atOne);
  });

  it('shortestViolation(analysis) ends on any budget, an unbounded one included', async () => {
    // A deviation back to where it started: a cycle that costs one deviation a lap.
    const model = graph('0', { '0': [['on', [], '1'], ['back', [], '0']], '1': [['crash', [], '!crash']] });
    const result = await exploreOnce(model, { [DEVIATIONS_KEY]: Infinity });
    expect(shortestViolation(result)!.error).toBe('crash');
    expectConsistent(result);
  });

  it('prefers the trace with the fewest steps among equal-cost violations', async () => {
    // Preferred chain 0..10 with a deviation at 10 that fails after 11 steps;
    // a deviation at 0 fails after 4 steps. Both cost exactly one deviation.
    const edges: Record<string, Edge[]> = {
      '0': [['next', [], '1'], ['toD', [], 'D0']],
      '10': [['end', [], '11'], ['crashLong', [], '!crashLong']],
      D0: [['d', [], 'D1']],
      D1: [['d', [], 'D2']],
      D2: [['crashShort', [], '!crashShort']],
    };
    for (let i = 1; i < 10; i++) edges[String(i)] = [['next', [], String(i + 1)]];
    const space = await exploreIteratively(new StateSpaceCache(graph('0', edges)));
    expect(space.violation!.steps.map((s) => s.event)).toEqual(['toD', 'd', 'd', 'crashShort']);
    expectConsistent(space);
  });

  it('reaches shared states at minimum depth even when found later in a level', async () => {
    // At deviation level 1, X is reachable via a long preferred chain plus a
    // late deviation (11 steps) and via an early deviation plus two steps (3
    // steps). The error out of X must be reported through the short route.
    const edges: Record<string, Edge[]> = {
      '0': [['next', [], '1'], ['toD', [], 'D0']],
      '10': [['end', [], '11'], ['late', [], 'X']],
      D0: [['d', [], 'X']],
      X: [['crash', [], '!crash']],
    };
    for (let i = 1; i < 10; i++) edges[String(i)] = [['next', [], String(i + 1)]];
    const space = await exploreIteratively(new StateSpaceCache(graph('0', edges)));
    expect(space.violation!.steps.map((s) => s.event)).toEqual(['toD', 'd', 'crash']);
    expectConsistent(space);
  });

  it('violation steps carry the accumulated cost, in both the embedded and recomputed path', async () => {
    const cache = new StateSpaceCache(
      graph('0', { '0': [['a', [], '1'], ['b', ['c'], '2']], '1': [['a', [], '2'], ['b', ['c'], '!x']] }),
    );
    const space = await exploreIteratively(cache, { baseBudget: { c: 1 } });
    const costs = space.violation!.steps.map((s) => Object.fromEntries(s.cost.entries()));
    expect(costs).toEqual([{}, {}]);
    expectConsistent(space);
    const recomputed = shortestViolation(space)!;
    expect(recomputed.steps.map((s) => Object.fromEntries(s.cost.entries()))).toEqual([{}, {}]);
  });

  it('a violation reports its whole cost, the failing event included', async () => {
    // The failing step is both a deviation and a `c`. Every step's `cost` is
    // the cost BEFORE it, so without `violation.cost` neither charge shows.
    const cache = new StateSpaceCache(
      graph('0', { '0': [['a', [], '1'], ['b', ['c'], '2']], '1': [['a', [], '2'], ['b', ['c', 'c'], '!x']] }),
    );
    const space = await exploreIteratively(cache, { baseBudget: { c: 2 } });
    expect(space.violation!.steps.map((s) => Object.fromEntries(s.cost.entries()))).toEqual([{}, {}]);
    expect(Object.fromEntries(space.violation!.cost.entries())).toEqual({ c: 2, [DEVIATIONS_KEY]: 1 });
    expectConsistent(space);
  });

  it('violation steps carry the index of their event: 0 for the baseline, else a deviation', async () => {
    // The only failure is two deviations deep, with a baseline step between them.
    const space = await exploreIteratively(
      new StateSpaceCache(
        graph('0', {
          '0': [['stay', [], 'end'], ['skip', [], 'end'], ['stray', [], '1']],
          '1': [['on', [], '2']],
          '2': [['fine', [], 'end'], ['crash', [], '!crash']],
        }),
      ),
    );
    expect(space.violation!.steps.map((s) => [s.event, s.index])).toEqual([['stray', 2], ['on', 0], ['crash', 1]]);
    // One deviation per non-baseline step, whatever its index.
    expect(space.violation!.cost.get(DEVIATIONS_KEY)).toBe(2);
    expectConsistent(space);
  });

  it('an event listed twice is reported at the index it was taken at', async () => {
    // `go` is the baseline at index 0 and listed again at index 1: one edge,
    // computed once, reachable at two costs. The cheap arrival is the baseline.
    const config = graph('0', { '0': [['go', [], '1'], ['go', [], '1']], '1': [['crash', [], '!crash']] });
    const space = await exploreIteratively(new StateSpaceCache(config));
    expect(space.violation!.steps.map((s) => [s.event, s.index])).toEqual([['go', 0], ['crash', 0]]);
    expect(space.violation!.cost.size).toBe(0);
    expectConsistent(space);
  });
});

describe('exhaustive: what a result without a violation proves', () => {
  // The only failure is two deviations deep.
  const twoDeep = () =>
    graph('0', { '0': [['ok', [], 'end'], ['stray', [], '1']], '1': [['ok', [], 'end'], ['crash', [], '!crash']] });

  it('a run capped below the failure completes, finds nothing, and is not exhaustive', async () => {
    const cache = new StateSpaceCache(twoDeep());
    const capped = await exploreIteratively(cache, { maxDeviations: 1 });
    // This is the result that reads like a proof and is not one.
    expect(capped).toMatchObject({ completed: true, violation: null, maxDeviationsReached: 1, exhaustive: false });

    const full = await exploreIteratively(cache);
    expect(full.violation!.steps.map((s) => s.event)).toEqual(['stray', 'crash']);
  });

  it('is true once no edge is left at any budget, and only then', async () => {
    const cache = new StateSpaceCache(graph('0', { '0': [['a', [], '1'], ['b', [], '2']], '1': [['a', [], '2']] }));
    expect(cache.exhaustive).toBe(false); // nothing explored yet: no edges pending, and no proof either
    expect((await explore(cache, { [DEVIATIONS_KEY]: 0 })).exhaustive).toBe(false); // `b` waits for a deviation
    expect((await explore(cache, { [DEVIATIONS_KEY]: 1 })).exhaustive).toBe(true);
    expect(cache.exhaustive).toBe(true);
  });

  it('an edge no deviation budget can afford keeps a run from being exhaustive', async () => {
    // `locked` needs a `k` that the base budget never grants.
    const config = graph('0', { '0': [['free', [], 'end'], ['locked', ['k'], '!behind the lock']] });
    const without = await exploreIteratively(new StateSpaceCache(config), { maxDeviations: 3 });
    expect(without).toMatchObject({ completed: true, violation: null, exhaustive: false });

    const withKey = await exploreIteratively(new StateSpaceCache(config), { baseBudget: { k: 1 } });
    expect(withKey.violation!.error).toBe('behind the lock');
  });

  it('a run stops deepening where no larger deviation budget could find more, however large maxDeviations is', async () => {
    // Past one deviation, all that is left is `locked`, and no number of deviations buys a `k`.
    const config = graph('0', { '0': [['free', [], 'end'], ['locked', ['k'], '!behind the lock']] });
    for (const maxDeviations of [100, Infinity]) {
      const space = await exploreIteratively(new StateSpaceCache(config), { maxDeviations });
      expect(space).toMatchObject({ completed: true, violation: null, exhaustive: false, maxDeviationsReached: 1 });
    }
  });

  it('a second run on a kept cache reports what the first one found', async () => {
    const cache = new StateSpaceCache(twoDeep());
    const first = await exploreIteratively(cache);
    // Everything is in the cache now, but the failure is still two deviations deep.
    const second = await exploreIteratively(cache);
    expect(second.violation!.steps.map((s) => s.event)).toEqual(['stray', 'crash']);
    expect(second).toMatchObject({ exhaustive: true, maxDeviationsReached: 2 });
    expect(first).toMatchObject({ exhaustive: true, maxDeviationsReached: 2 });
  });

  it('is about the budget a result is for: a cache explored at a larger one holds more than it shows', async () => {
    const cache = new StateSpaceCache(graph('0', { '0': [['free', [], 'end'], ['locked', ['k'], '!behind the lock']] }));
    expect((await explore(cache, { k: 1, [DEVIATIONS_KEY]: 1 })).exhaustive).toBe(true);
    expect(cache.exhaustive).toBe(true);
    // Without a `k`, the violation behind the lock is out of sight: no proof.
    expect((await explore(cache, { [DEVIATIONS_KEY]: 1 })).exhaustive).toBe(false);
    const space = await exploreIteratively(cache);
    expect(space).toMatchObject({ completed: true, violation: null, exhaustive: false, maxDeviationsReached: 1 });
  });

  it('can be true alongside a violation: an error edge leads nowhere further', async () => {
    const space = await exploreIteratively(new StateSpaceCache(graph('0', { '0': [['crash', [], '!crash']] })));
    expect(space.violation).not.toBeNull();
    expect(space.exhaustive).toBe(true);
  });

  it('exploreOnce reports it for its one budget', async () => {
    expect((await exploreOnce(twoDeep(), { [DEVIATIONS_KEY]: 1 })).exhaustive).toBe(false);
    expect((await exploreOnce(twoDeep(), { [DEVIATIONS_KEY]: 2 })).exhaustive).toBe(true);
  });
});

describe('describing a model', () => {
  it('cost may be omitted, and means no cost keys', async () => {
    const model: Model<string, string> = {
      initialState: 'a',
      getEvents: (state) => (state === 'a' ? [{ event: 'go' }, { event: 'pay', cost: ['k'] }] : []),
      applyEvent: (_, event) => ({ to: event === 'go' ? 'b' : 'c' }),
    };
    const space = await exploreOnce(model, { [DEVIATIONS_KEY]: 1, k: 1 });
    expect(space.transitions.get('a')).toEqual([
      { event: 'go', index: 0, cost: [], to: 'b' },
      { event: 'pay', index: 1, cost: ['k'], to: 'c' },
    ]);
    expect(Object.fromEntries(space.costs.get('c')![0]!.entries())).toEqual({ k: 1, [DEVIATIONS_KEY]: 1 });
  });

  it('callbacks may be synchronous, and a synchronous throw is an error result', async () => {
    const space = await exploreIteratively<number, string>({
      initialState: 0,
      getEvents: (n) => (n < 3 ? [{ event: 'inc' }] : []),
      applyEvent(n) {
        if (n === 2) throw new Error('three is too many');
        return { to: n + 1 };
      },
    });
    expect(space.violation!.steps.map((s) => s.state)).toEqual([0, 1, 2]);
    expect((space.violation!.error as Error).message).toBe('three is too many');
  });

  it('exploreIteratively takes a model directly, or a cache to keep', async () => {
    const model = makeConfig({ heads: 0, tossesRemaining: 3 }, 2);
    const direct = await exploreIteratively(model);
    const cache = new StateSpaceCache(model);
    const cached = await exploreIteratively(cache);
    expect(direct.violation!.steps.map((s) => s.event)).toEqual(cached.violation!.steps.map((s) => s.event));
    expect(direct.edgesComputed).toBe(cache.edgesComputed);
  });

  it('ExplorerConfig is still accepted: it is the old name of Model', async () => {
    const config: ExplorerConfig<string, string> = graph('0', { '0': [['a', [], '1']] });
    const model: Model<string, string> = config;
    expect((await exploreIteratively(model)).exhaustive).toBe(true);
  });

  it('applyEvent returns { to } or { error }: badState is the cache\'s to add', async () => {
    // @ts-expect-error `badState` reports a state that failed a check; a model does not return one
    const typed: ApplyResult<number> = { error: 'broken', badState: 42 };
    expect(typed).toMatchObject({ error: 'broken' });

    // The types do not see every return (an arrow function's literal is not
    // checked for extra properties), so the cache drops one it is given.
    const model: Model<number, string> = { initialState: 0, getEvents: () => [{ event: 'go' }], applyEvent: () => ({ error: 'broken', badState: 42 }) };
    const space = await exploreIteratively(model);
    expect(space.violation!.error).toBe('broken');
    expect('badState' in space.violation!).toBe(false);
    expect(space.transitions.get(0)).toEqual([{ event: 'go', index: 0, cost: [], error: 'broken' }]);
  });
});

describe('what a cache offers', () => {
  it('the model, the initial state, exhaustive, statesExplored and the counters', async () => {
    const model = graph('0', { '0': [['a', [], '1']] });
    const cache = new StateSpaceCache(model);
    await explore(cache, {});
    expect(cache.model).toBe(model);
    expect(cache.config).toBe(model); // the old name, deprecated
    expect(cache).toMatchObject({ initialState: '0', exhaustive: true, statesExplored: 2, edgesComputed: 1, exploreCalls: 1 });
  });

  it('the counters are read-only', () => {
    const cache = new StateSpaceCache(graph('0', {}));
    expect(Reflect.set(cache, 'edgesComputed', 5)).toBe(false);
    expect(cache.edgesComputed).toBe(0);
  });
});

describe('invariant', () => {
  /** `graph`, with every state whose name starts with `bad` failing the invariant. */
  function guarded(initial: string, edges: Record<string, Edge[]>): Model<string, string> & { checked: string[] } {
    const checked: string[] = [];
    return {
      ...graph(initial, edges),
      checked,
      invariant(state) {
        checked.push(state);
        return state.startsWith('bad') ? { error: `${state} must not be reached` } : undefined;
      },
    };
  }

  it('reaching a state that fails is a violation that ends at that state', async () => {
    const space = await exploreIteratively(guarded('0', { '0': [['a', [], '1']], '1': [['b', [], 'bad']] }));
    expect(space.violation).toMatchObject({ error: 'bad must not be reached', badState: 'bad' });
    expect(space.violation!.steps.map((s) => [s.state, s.event])).toEqual([['0', 'a'], ['1', 'b']]);
    expectConsistent(space);
  });

  it('nothing is explored beyond a state that fails', async () => {
    const getEvents = vi.fn((state: string) => (state === 'bad' ? [{ event: 'further' }] : [{ event: 'go' }]));
    const space = await exploreIteratively<string, string>({
      initialState: '0',
      getEvents,
      applyEvent: (_, event) => ({ to: event === 'go' ? 'bad' : 'beyond' }),
      invariant: (state) => (state === 'bad' ? { error: 'bad' } : undefined),
    });
    expect(getEvents.mock.calls.map(([state]) => state)).toEqual(['0']);
    expect(space.costs.has('bad')).toBe(false);
    expect(space.transitions.get('0')).toEqual([{ event: 'go', index: 0, cost: [], error: 'bad', badState: 'bad' }]);
    expect(space.exhaustive).toBe(true);
  });

  it('is checked once per distinct state, however many edges lead there and however many runs', async () => {
    const model = guarded('0', {
      '0': [['a', [], '1'], ['b', [], '2']],
      '1': [['c', [], '3']],
      '2': [['c', [], '3']],
    });
    const cache = new StateSpaceCache(model);
    await exploreIteratively(cache);
    await explore(cache, { [DEVIATIONS_KEY]: 5 });
    expect([...model.checked].sort()).toEqual(['0', '1', '2', '3']);
  });

  it('an initial state that fails is a violation with no steps, and nothing is explored', async () => {
    const model = guarded('bad start', { 'bad start': [['a', [], '1']] });
    const getEvents = vi.spyOn(model, 'getEvents');
    const space = await exploreIteratively(model);
    expect(space.violation).toMatchObject({ steps: [], error: 'bad start must not be reached', badState: 'bad start' });
    expect(space.violation!.cost.size).toBe(0);
    expect(space.maxDeviationsReached).toBe(0);
    expect(getEvents).not.toHaveBeenCalled();
    expectConsistent(space);
  });

  it('is ordered with applyEvent errors: the cheapest violation wins, whichever kind it is', async () => {
    // A failing state one deviation away; an applyEvent error on the baseline, three steps in.
    const cheapError = await exploreIteratively(
      guarded('0', { '0': [['on', [], '1'], ['stray', [], 'bad']], '1': [['on', [], '2']], '2': [['crash', [], '!crash']] }),
    );
    expect(cheapError.violation).toMatchObject({ error: 'crash' });
    expect('badState' in cheapError.violation!).toBe(false);
    expectConsistent(cheapError);

    // The other way round: the failing state is on the baseline.
    const cheapState = await exploreIteratively(
      guarded('0', { '0': [['on', [], '1'], ['stray', [], '!crash']], '1': [['on', [], 'bad']] }),
    );
    expect(cheapState.violation).toMatchObject({ error: 'bad must not be reached', badState: 'bad' });
    expect(cheapState.maxDeviationsReached).toBe(0);
    expectConsistent(cheapState);
  });

  it('may be async, and a throw is a failure', async () => {
    const space = await exploreIteratively<number, string>({
      initialState: 0,
      getEvents: () => [{ event: 'inc' }],
      applyEvent: (n) => ({ to: n + 1 }),
      async invariant(n) {
        await Promise.resolve();
        if (n >= 3) throw new Error(`${n} is too many`);
      },
    });
    expect((space.violation!.error as Error).message).toBe('3 is too many');
    expect(space.violation!.badState).toBe(3);
    expect(space.violation!.steps).toHaveLength(3);
  });

  it('badState is the canonical value, identical to the same state reached elsewhere', async () => {
    const space = await exploreIteratively<{ n: number }, string>(
      {
        initialState: { n: 0 },
        getEvents: (s) => (s.n === 0 ? [{ event: 'safe' }, { event: 'unsafe' }] : []),
        applyEvent: (_, event) => ({ to: { n: event === 'safe' ? 1 : 2 } }),
        invariant: (s) => (s.n === 2 ? { error: 'two' } : undefined),
      },
      { stopOnViolation: false },
    );
    const viaTransition = space.transitions.get(space.initialState)!.find((t) => 'error' in t)!;
    expect(space.violation!.badState).toEqual({ n: 2 });
    expect(space.violation!.badState).toBe('badState' in viaTransition ? viaTransition.badState : undefined);
  });
});

describe('terminalInvariant', () => {
  it('tells an acceptable end from a deadlock, and reports the state that is stuck', async () => {
    // Two ways for a run to end: at `done`, and at `stuck`, one deviation away.
    const space = await exploreIteratively<string, string>({
      ...graph('0', { '0': [['work', [], 'done'], ['wait', [], 'stuck']] }),
      terminalInvariant: (state) => (state === 'done' ? undefined : { error: `deadlock at ${state}` }),
    });
    expect(space.violation).toMatchObject({ error: 'deadlock at stuck', badState: 'stuck' });
    expect(space.violation!.steps.map((s) => [s.event, s.index])).toEqual([['wait', 1]]);
    expect(space.maxDeviationsReached).toBe(1); // budget 0 ended at `done`, which is fine
    expectConsistent(space);
  });

  it('sees only states with no events, once each, and getEvents still runs once per state', async () => {
    const seen: string[] = [];
    const model = {
      ...graph('0', { '0': [['a', [], '1'], ['b', [], '2']], '1': [['c', [], 'end']], '2': [['c', [], 'end']] }),
      terminalInvariant(state: string) {
        seen.push(state);
      },
    };
    const getEvents = vi.spyOn(model, 'getEvents');
    const cache = new StateSpaceCache(model);
    const space = await exploreIteratively(cache);
    await explore(cache, { [DEVIATIONS_KEY]: 5 });
    expect(seen).toEqual(['end']);
    expect(getEvents.mock.calls.map(([state]) => state).sort()).toEqual(['0', '1', '2', 'end']);
    expect(space).toMatchObject({ violation: null, exhaustive: true });
  });

  it('a state whose events are all unaffordable is not terminal', async () => {
    const terminalInvariant = vi.fn(() => ({ error: 'stuck' }));
    const model = { ...graph('0', { '0': [['go', [], '1']], '1': [['pay', ['k'], '2']], '2': [['on', [], '3']] }), terminalInvariant };
    // No `k` in the budget: the run cannot leave `1`, but `1` has an event, so it is not an end.
    const broke = await exploreIteratively(new StateSpaceCache(model), { maxDeviations: 2 });
    expect(broke).toMatchObject({ violation: null, exhaustive: false });
    expect(terminalInvariant).not.toHaveBeenCalled();
    // With it, the run reaches the real end.
    const paid = await exploreIteratively(new StateSpaceCache(model), { baseBudget: { k: 1 } });
    expect(paid.violation).toMatchObject({ error: 'stuck', badState: '3' });
  });

  it('comes after invariant, which still keeps getEvents away from a state it fails', async () => {
    const calls: string[] = [];
    const space = await exploreIteratively<string, string>({
      initialState: '0',
      getEvents(state) {
        calls.push(`getEvents ${state}`);
        return state === '0' ? [{ event: 'go' }] : [];
      },
      applyEvent: () => ({ to: 'bad end' }),
      invariant(state) {
        calls.push(`invariant ${state}`);
        return state.startsWith('bad') ? { error: 'bad' } : undefined;
      },
      terminalInvariant(state) {
        calls.push(`terminalInvariant ${state}`);
        return { error: 'stuck' };
      },
    });
    expect(calls).toEqual(['invariant 0', 'getEvents 0', 'invariant bad end']);
    expect(space.violation).toMatchObject({ error: 'bad', badState: 'bad end' });
  });

  it('an initial state with nothing to do is checked too', async () => {
    const space = await exploreIteratively<string, string>({
      initialState: 'nothing to do',
      getEvents: () => [],
      applyEvent: () => ({ error: 'unreachable' }),
      terminalInvariant: () => ({ error: 'nothing ever happened' }),
    });
    expect(space.violation).toMatchObject({ steps: [], error: 'nothing ever happened', badState: 'nothing to do' });
    expectConsistent(space);
  });

  it('may be async, and a throw is a failure', async () => {
    const space = await exploreIteratively<number, string>({
      initialState: 0,
      getEvents: (n) => (n < 2 ? [{ event: 'inc' }] : []),
      applyEvent: (n) => ({ to: n + 1 }),
      async terminalInvariant(n) {
        await Promise.resolve();
        throw new Error(`ended at ${n}`);
      },
    });
    expect((space.violation!.error as Error).message).toBe('ended at 2');
    expect(space.violation!.badState).toBe(2);
  });
});
