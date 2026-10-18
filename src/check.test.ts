import { describe, expect, it } from 'vitest';
import {
  type Model,
  DEVIATIONS_KEY,
  IncompleteError,
  STEPS_KEY,
  StateSpaceCache,
  ViolationError,
  analyzeCache,
  check,
  formatViolation,
} from './index.js';

/** Counts up to `end`, with a way to stray at the start; `bad`, if given, is a count that must not be reached having strayed. */
function counter(end: number, bad?: number): Model<{ n: number; strayed: boolean }, string> {
  return {
    initialState: { n: 0, strayed: false },
    getEvents: (s) => (s.n >= end ? [] : s.n === 0 ? [{ event: 'on' }, { event: 'stray' }] : [{ event: 'on' }]),
    applyEvent: (s, e) => ({ to: { n: s.n + 1, strayed: s.strayed || e === 'stray' } }),
    invariant: (s) => (s.strayed && s.n === bad ? { error: new Error(`strayed to ${s.n}`) } : undefined),
    describeEvent: (event, state) => `${event} from ${state.n}`,
  };
}

describe('check', () => {
  it('resolves with the state space when the search finds nothing', async () => {
    const space = await check(counter(3));
    expect(space).toMatchObject({ violation: null, completed: true, exhaustive: true });
    expect(space.costs.size).toBe(7);
  });

  it('rejects with a ViolationError: the report as its message, the violation, and the model\'s error as its cause', async () => {
    const model = counter(3, 2);
    const error: unknown = await check(model).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViolationError);
    const { message, name, violation, cause } = error as ViolationError<{ n: number; strayed: boolean }, string>;
    expect(name).toBe('ViolationError');
    expect(violation.steps.map((s) => s.index)).toEqual([1, 0]);
    expect(message).toBe(formatViolation(violation, model));
    expect(message.split('\n')).toEqual([
      'strayed to 2',
      '1 deviation, 2 steps',
      '  1. stray from 0  (deviation)',
      '  2. on from 1',
      'in state: {"n":2,"strayed":true}',
    ]);
    expect(cause).toBe(violation.error);
    expect((cause as Error).message).toBe('strayed to 2');
  });

  it('either error carries the result of the search, as check would have resolved with it', async () => {
    // A wrapper that reports what a search did needs it when the search failed too.
    const failed = (await check(counter(3, 2)).catch((e: unknown) => e)) as ViolationError;
    expect(failed.space).toMatchObject({ completed: true, maxDeviationsReached: 1, violation: failed.violation });
    expect(failed.space!.costs.size).toBe(5); // the counts 0 to 3 without straying, and 1 having strayed
    const cut = (await check(counter(10), { maxEdges: 12 }).catch((e: unknown) => e)) as IncompleteError;
    expect(cut.space).toMatchObject({ completed: false, edgesComputed: 12, maxDeviationsReached: 0, violation: null });
    expect(cut.space.costs.size).toBe(13); // the counts 0 to 10 without straying, and 1 and 2 having strayed, where the limit fell
    // Made by hand, a ViolationError has no space to carry.
    expect(new ViolationError(failed.violation).space).toBeUndefined();
  });

  it('takes a cache, which the caller keeps', async () => {
    const cache = new StateSpaceCache(counter(3, 2));
    await expect(check(cache)).rejects.toBeInstanceOf(ViolationError);
    // The cache holds the search; other budgets can be asked of it.
    expect(analyzeCache(cache, { [DEVIATIONS_KEY]: 0 }).violation).toBeNull();
    expect(analyzeCache(cache, { [DEVIATIONS_KEY]: 1 }).violation).not.toBeNull();
  });

  it('rejects with an IncompleteError when a limit cut the search short and nothing was found', async () => {
    const error: unknown = await check(counter(10), { maxEdges: 12 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IncompleteError);
    // Budget 0 is the ten steps of the baseline; budget 1 ran out.
    expect(error).toMatchObject({ name: 'IncompleteError', timedOut: false, edgesComputed: 12, maxDeviationsReached: 0 });
    expect((error as Error).message).toMatch(/cut short by maxEdges after 12 edges.*budgets up to 0 are clear/);
  });

  it('says which limit it was, and when no budget at all was cleared', async () => {
    const error: unknown = await check(counter(10), { timeoutMs: 0 }).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'IncompleteError', timedOut: true, maxDeviationsReached: -1 });
    expect((error as Error).message).toMatch(/cut short by timeoutMs.*no deviation budget is clear/);
  });

  it('with incomplete: \'allow\', resolves with what the search did get to', async () => {
    const space = await check(counter(10), { maxEdges: 12, incomplete: 'allow' });
    expect(space).toMatchObject({ violation: null, completed: false, exhaustive: false, maxDeviationsReached: 0 });
  });

  it('a violation found by a search that was cut short is a violation all the same', async () => {
    // Budget 1 has three edges. The first of them fails, and the search is stopped before the next.
    const model: Model<string, string> = {
      initialState: 'start',
      getEvents: (s) => (s === 'start' ? ['fine', 'bad', 'other', 'another'].map((event) => ({ event })) : []),
      applyEvent: (_, e) => (e === 'bad' ? { error: 'bad' } : { to: e }),
    };
    const error: unknown = await check(model, { maxEdges: 2 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViolationError);
    expect((error as Error).message.split('\n')).toEqual(['bad', '1 deviation, 1 step', '  1. bad  (deviation)']);
    await expect(check(model, { maxEdges: 2, incomplete: 'allow' })).rejects.toBeInstanceOf(ViolationError);
  });

  it('a search that clears its budget resolves, though more budget may find a failure: exhaustive says which', async () => {
    const model = counter(3, 2);
    // No deviations allowed: the failure needs one.
    const capped = await check(model, { maxDeviations: 0 });
    expect(capped).toMatchObject({ violation: null, completed: true, exhaustive: false });
    // One step allowed: the failure needs two.
    const short = await check(model, { baseBudget: { [STEPS_KEY]: 1 } });
    expect(short).toMatchObject({ violation: null, completed: true, exhaustive: false });
  });

  it('an `incomplete` it cannot read is an error, not a default', async () => {
    await expect(check(counter(1), { incomplete: 'alow' as 'allow' })).rejects.toThrow(RangeError);
  });

  it('an option given as undefined is the default, as one left out is', async () => {
    // So a wrapper may pass its own optional options straight through, under
    // exactOptionalPropertyTypes too: every option's type admits undefined.
    const space = await check(counter(3), {
      baseBudget: undefined,
      maxDeviations: undefined,
      maxEdges: undefined,
      timeoutMs: undefined,
      stopOnViolation: undefined,
      incomplete: undefined,
      report: undefined,
    });
    expect(space).toMatchObject({ completed: true, exhaustive: true, maxDeviationsReached: 1 });
  });
});
