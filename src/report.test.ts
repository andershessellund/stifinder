import { describe, expect, it } from 'vitest';
import { type Model, DEVIATIONS_KEY, exploreIteratively, exploreOnce, formatViolation } from './index.js';

/** A run of up to `length` events, each `on` or, as a deviation and a `fault`, `stray`; straying twice is wrong. */
function strays(length: number): Model<{ n: number; strayed: number }, string> {
  return {
    initialState: { n: 0, strayed: 0 },
    getEvents: (s) => (s.n >= length ? [] : [{ event: 'on' }, { event: 'stray', cost: ['fault'] }]),
    applyEvent: (s, e) => ({ to: { n: s.n + 1, strayed: s.strayed + (e === 'stray' ? 1 : 0) } }),
    invariant: (s) => (s.strayed >= 2 ? { error: new Error('strayed twice') } : undefined),
  };
}

describe('formatViolation', () => {
  it('gives the error, what the path cost, each step with what it was charged, and the state that failed', async () => {
    const model: Model<{ n: number; strayed: number }, string> = {
      ...strays(3),
      describeEvent: (event, state) => `${event} from ${state.n}`,
      describeState: (state) => `at ${state.n}, having strayed ${state.strayed} times`,
    };
    // The shortest failure is two strays in a row.
    const { violation } = await exploreOnce(model, {});
    expect(formatViolation(violation!, model).split('\n')).toEqual([
      'strayed twice',
      '2 deviations, 2 steps, fault: 2',
      '  1. stray from 0  (deviation, fault)',
      '  2. stray from 1  (deviation, fault)',
      'in state: at 2, having strayed 2 times',
    ]);
  });

  it('says nothing after a step that was charged only the step', async () => {
    // Fails at the third `on`: no deviation, no cost key.
    const space = await exploreIteratively<number, string>({
      initialState: 0,
      getEvents: () => [{ event: 'on' }, { event: 'off' }],
      applyEvent: (n, e) => (n === 2 && e === 'on' ? { error: 'too far' } : { to: n + 1 }),
    });
    expect(formatViolation(space.violation!).split('\n')).toEqual(['too far', '0 deviations, 3 steps', '  1. on', '  2. on', '  3. on']);
  });

  it('without describers, shows a string as it is and anything else as JSON', async () => {
    const space = await exploreIteratively<{ at: number }, { go: string } | string>({
      initialState: { at: 0 },
      getEvents: (s) => (s.at === 0 ? [{ event: { go: 'on' } }] : [{ event: 'stop' }]),
      applyEvent: (s) => ({ to: { at: s.at + 1 } }),
      invariant: (s) => (s.at === 2 ? { error: { code: 7 } } : undefined),
    });
    expect(formatViolation(space.violation!).split('\n')).toEqual([
      '{"code":7}',
      '0 deviations, 2 steps',
      '  1. {"go":"on"}',
      '  2. stop',
      'in state: {"at":2}',
    ]);
  });

  it('charges a cost key taken twice in one step as two, and names one unit a deviation and one step', async () => {
    const space = await exploreIteratively<string, string>({
      initialState: 'a',
      getEvents: () => [{ event: 'fine' }, { event: 'costly', cost: ['k', 'k', 'j'] }],
      applyEvent: (_, e) => (e === 'costly' ? { error: 'boom' } : { to: 'end' }),
      terminalInvariant: () => undefined,
    });
    expect(space.violation!.cost.get(DEVIATIONS_KEY)).toBe(1);
    expect(formatViolation(space.violation!).split('\n')).toEqual([
      'boom',
      '1 deviation, 1 step, j: 1, k: 2',
      '  1. costly  (deviation, j, k ×2)',
    ]);
  });

  it('a violation with no steps is the initial state failing', async () => {
    const model: Model<string, string> = {
      initialState: 'broken from the start',
      getEvents: () => [],
      applyEvent: () => ({ error: 'unreachable' }),
      invariant: () => ({ error: new Error('never right') }),
      describeState: (state) => state.toUpperCase(),
    };
    const space = await exploreIteratively(model);
    expect(formatViolation(space.violation!, model).split('\n')).toEqual([
      'never right',
      'no steps: the initial state fails',
      'in state: BROKEN FROM THE START',
    ]);
  });

  it('a describer that throws does not hide the failure: the value is shown as it is', async () => {
    const model: Model<{ n: number; strayed: number }, string> = {
      ...strays(2),
      describeEvent: () => {
        throw new Error('cannot describe');
      },
      describeState: () => {
        throw new Error('cannot describe');
      },
    };
    const { violation } = await exploreOnce(model, {});
    expect(formatViolation(violation!, model).split('\n')).toEqual([
      'strayed twice',
      '2 deviations, 2 steps, fault: 2',
      '  1. stray  (deviation, fault)',
      '  2. stray  (deviation, fault)',
      'in state: {"n":2,"strayed":2}',
    ]);
  });

  it('a description of several lines hangs under its first, and steps are numbered to one width', async () => {
    const model: Model<number, string> = {
      initialState: 0,
      getEvents: () => [{ event: 'on' }],
      applyEvent: (n) => ({ to: n + 1 }),
      invariant: (n) => (n === 10 ? { error: 'ten' } : undefined),
      describeEvent: (event, n) => (n === 8 ? 'the ninth\nis longer' : event),
      describeState: () => 'first line\nsecond line',
    };
    const lines = formatViolation((await exploreIteratively(model)).violation!, model).split('\n');
    expect(lines.slice(9)).toEqual([
      '   8. on',
      '   9. the ninth',
      '      is longer',
      '  10. on',
      'in state: first line',
      '          second line',
    ]);
  });

  it('an Error with no message is shown by its name', async () => {
    const space = await exploreIteratively<string, string>({
      initialState: 'a',
      getEvents: () => [{ event: 'e' }],
      applyEvent: () => {
        throw new TypeError();
      },
    });
    expect(formatViolation(space.violation!).split('\n')[0]).toBe('TypeError');
  });
});
