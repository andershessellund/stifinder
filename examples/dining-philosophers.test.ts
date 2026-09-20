import { describe, expect, it } from 'vitest';
import { report } from './dining-philosophers.js';

// The README quotes this output; the example is only worth having if it stays true.
describe('examples/dining-philosophers', () => {
  it('left fork first: the shortest deadlock has every philosopher but the first cut in', async () => {
    expect(await report(5, 'left-first')).toEqual([
      'left-first: deadlock, 4 deviations from the expected schedule.',
      '  P0 takes fork 0',
      '  P1 takes fork 1  (cuts in)',
      '  P2 takes fork 2  (cuts in)',
      '  P3 takes fork 3  (cuts in)',
      '  P4 takes fork 4  (cuts in)',
    ]);
  });

  it('lowest fork first: the whole state space is explored, and holds no deadlock', async () => {
    expect(await report(5, 'lowest-first')).toEqual([
      'lowest-first: no deadlock. 214 states, every schedule explored.',
    ]);
  });

  it('the deadlock needs one deviation per philosopher after the first, at any table size', async () => {
    for (const n of [2, 3, 4, 6]) {
      const [summary, ...trace] = await report(n, 'left-first');
      expect(summary).toBe(`left-first: deadlock, ${n - 1} deviations from the expected schedule.`);
      expect(trace).toHaveLength(n);
      expect((await report(n, 'lowest-first'))[0]).toMatch(/^lowest-first: no deadlock\./);
    }
  });
});
