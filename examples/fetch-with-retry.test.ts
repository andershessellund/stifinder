import { describe, expect, it } from 'vitest';
import { ViolationError, check } from 'stifinder';
import { fetchWithRetry } from './fetch-with-retry.js';
import { http, mock, program, system } from './system.js';

// The test of a piece of real code: the code, behind a host; a mock server,
// a reducer at a base URL; the network between them; and what must hold
// wherever the system stops. Everything else is generic.
const counter = (retries: number) =>
  system(
    {
      client: program(({ fetch }) => fetchWithRetry(fetch, 'https://counter.test/increment', { retries })),
      net: http({ 'https://counter.test': 'server' }),
      server: mock({ count: 0 }, (state) => [
        { state: { count: state.count + 1 }, response: { status: 200 } },
        { state, response: { status: 500 }, label: 'answers 500', cost: ['server-error'] },
      ]),
    },
    ({ client, server }) => {
      expect(client.result).toEqual({ value: { status: 200 } });
      expect(server.state.count).toBeGreaterThanOrEqual(1);
    },
  );

describe('examples/fetch-with-retry', () => {
  it('gets an ok answer within as many faults as it retries, and the server counted at least once', async () => {
    const space = await check(counter(3), { maxDeviations: 3 });
    expect(space.maxDeviationsReached).toBe(3);
  });

  it('one fault more than it retries, and it gives up', async () => {
    const error = await check(counter(3), { maxDeviations: 4 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViolationError);
    expect((error as ViolationError).message.split('\n')).toEqual([
      "expected { error: 'connection refused' } to deeply equal { value: { status: 200 } }",
      '4 deviations, 5 steps, network-error: 4',
      '  1. the client starts',
      '  2. the connection fails, and the request never arrives  (deviation, network-error)',
      '  3. the connection fails, and the request never arrives  (deviation, network-error)',
      '  4. the connection fails, and the request never arrives  (deviation, network-error)',
      '  5. the connection fails, and the request never arrives  (deviation, network-error)',
      'in state: client: threw connection refused; net: nothing in flight; server: {"count":0}, 0 pending',
    ]);
  });

  it('code that does something the log cannot replay is the test\'s error', async () => {
    const model = system({
      client: program(({ fetch }) => fetchWithRetry(fetch, `https://counter.test/${Math.random()}`)),
      net: http({ 'https://counter.test': 'server' }),
      server: mock({ count: 0 }, (state) => ({ state: { count: state.count + 1 }, response: { status: 200 } })),
    });
    const error = await check(model).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViolationError);
    expect((error as ViolationError).message).toMatch(/^stifinder: the program diverged on replay: GET https:\/\/counter\.test\/0\.\d+ was not what the log has next\n/);
  });
});
