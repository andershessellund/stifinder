import { describe, expect, it } from 'vitest';
import { report } from './dining-philosophers.js';

// The README quotes this output; the example is only worth having if it stays true.
describe('examples/dining-philosophers', () => {
  it('left fork first: the shortest deadlock has every philosopher but the first cut in', async () => {
    expect(await report(5, 'left-first')).toEqual([
      'left-first: deadlock',
      '4 deviations, 5 steps',
      '  1. P0 takes fork 0',
      '  2. P1 takes fork 1  (deviation)',
      '  3. P2 takes fork 2  (deviation)',
      '  4. P3 takes fork 3  (deviation)',
      '  5. P4 takes fork 4  (deviation)',
      'in state: P0 has fork 0, P1 has fork 1, P2 has fork 2, P3 has fork 3, P4 has fork 4',
    ]);
  });

  it('lowest fork first: the whole state space is explored, and holds no deadlock', async () => {
    expect(await report(5, 'lowest-first')).toEqual([
      'lowest-first: no deadlock. 214 states, every schedule explored.',
    ]);
  });

  it('the deadlock needs one deviation per philosopher after the first, at any table size', async () => {
    for (const n of [2, 3, 4, 6]) {
      const [error, cost, ...trace] = await report(n, 'left-first');
      expect(error).toBe('left-first: deadlock');
      expect(cost).toBe(`${n - 1} deviation${n === 2 ? '' : 's'}, ${n} steps`);
      expect(trace).toHaveLength(n + 1); // one fork each, and the table they are left at
      expect((await report(n, 'lowest-first'))[0]).toMatch(/^lowest-first: no deadlock\./);
    }
  });
});
