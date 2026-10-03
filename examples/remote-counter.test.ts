import { describe, expect, it } from 'vitest';
import { ViolationError, check, decisionModel, decisionsOf, runOnce } from 'stifinder';
import { compareAndSet, readThenWrite, report, twoIncrements } from './remote-counter.js';

// The README quotes this output; the example is only worth having if it stays true.
describe('examples/remote-counter', () => {
  it('read-then-write loses an update when the clients interleave once', async () => {
    expect(await report(readThenWrite, { lostReplies: false })).toEqual([
      'readThenWrite: counted 1, not 2',
      '1 deviation, 3 steps',
      '  2. deliver A: get  (deviation)',
      'in state: decisions [0, 1, 0]',
    ]);
  });

  it('compare-and-set survives every interleaving, and the search proves it', async () => {
    expect(await report(compareAndSet, { lostReplies: false })).toEqual([
      'compareAndSet: correct, every schedule explored.',
    ]);
  });

  it('compare-and-set counts twice when the reply to a write that succeeded is lost', async () => {
    expect(await report(compareAndSet, { lostReplies: true })).toEqual([
      'compareAndSet, replies lost: counted 3, not 2',
      '1 deviation, 8 steps, lost: 1',
      '  6. the reply to A: set 2 if 1 is lost  (deviation, lost)',
      'in state: decisions [0, 0, 0, 0, 0, 1, 0, 0]',
    ]);
  });

  it('the failing run replays on its own, from its decisions', async () => {
    const body = twoIncrements(readThenWrite, { lostReplies: false });
    const error = await check(decisionModel(body)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViolationError);
    expect(decisionsOf(error as ViolationError<unknown, unknown>)).toEqual([0, 1, 0]);
    await expect(runOnce(body, error as ViolationError<unknown, unknown>)).rejects.toThrow('counted 1, not 2');
    await expect(runOnce(body, [])).resolves.toBeUndefined(); // the expected run counts right
  });
});
