import { describe, expect, it } from 'vitest';
import { report } from './fetch-with-retry.js';

// The README quotes this output; the example is only worth having if it stays true.
describe('examples/fetch-with-retry', () => {
  it('within as many faults as it retries, the function returns ok and the server counted', async () => {
    expect(await report(3, 3)).toEqual(['3 retries: holds within 3 faults. 1217 states.']);
  });

  it('one fault more, and it gives up; the report says how', async () => {
    expect(await report(3, 4)).toEqual([
      '3 retries: the client threw: The operation was aborted due to timeout',
      '4 deviations, 17 steps',
      '   4. client waits 1000 ms  (deviation)',
      '   8. client waits 1000 ms  (deviation)',
      '  12. client waits 1000 ms  (deviation)',
      '  16. client waits 1000 ms  (deviation)',
      'in state: client: threw The operation was aborted due to timeout; net: nothing in flight; server: {"count":4}',
    ]);
  });
});
