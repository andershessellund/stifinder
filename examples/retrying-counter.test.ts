import { describe, expect, it } from 'vitest';
import { IncompleteError, check } from 'stifinder';
import { report, retryingCounter } from './retrying-counter.js';

describe('examples/retrying-counter', () => {
  it('within three faults, wherever the client stops the counter is at least one', async () => {
    expect(await report('at least one', 3)).toEqual(['at least one: holds within 3 faults. 76 states.']);
  });

  it('one fault is enough for the counter to reach two: the client gives up on an answer in flight', async () => {
    expect(await report('exactly one', 3)).toEqual([
      'exactly one: the counter is 2',
      '1 deviation, 7 steps',
      '  1. the client sends',
      '  2. the request is delivered',
      '  3. the server counts and answers ok',
      '  4. the client gives up and sends again  (deviation)',
      '  5. the request is delivered',
      '  6. the server counts and answers ok',
      '  7. the ok answer is delivered',
      'in state: client: done; net: nothing in flight; server: count 2, 0 pending',
    ]);
  });

  it('the space has no end without a bound on faults: every further fault is another count', async () => {
    await expect(check(retryingCounter('at least one'), { maxEdges: 3000 })).rejects.toThrow(IncompleteError);
  });
});
