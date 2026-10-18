// ---------------------------------------------------------------------------
// Real code under test: a fetch that tries again, over a mock server and a
// simulated network.
//
// `fetchWithRetry` is production code. It takes its host as an argument and
// uses the host's fetch and timeout where it would use the globals; in
// production the host is `webHost()` from `stifinder/host`, the platform
// itself. The test names a mock server at a URL, the network between, and
// what must hold wherever the system stops, and the search explores every
// schedule of answers, failures, losses and timeouts within a fault budget.
// Within as many faults as the function retries, it returns an ok answer
// and the server counted; one fault more and it gives up, and the report
// says how.
//
//     pnpm build && node examples/fetch-with-retry.ts
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'node:url';
import { type Host, ViolationError, check, http, mock, program, system } from 'stifinder';

export interface RetryOptions {
  /** Tries after the first. Default 3. */
  retries?: number;
  /** How long to wait for an answer before giving up on it, in ms. Default 1000. */
  timeoutMs?: number;
}

/** Fetch `url`, and try again after an error answer, a failed connection or a timeout, up to `retries` more times. */
export async function fetchWithRetry(
  host: Pick<Host, 'fetch' | 'timeoutSignal'>,
  url: string,
  { retries = 3, timeoutMs = 1000 }: RetryOptions = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await host.fetch(url, { signal: host.timeoutSignal(timeoutMs) });
      if (response.ok || attempt === retries) return response;
    } catch (error) {
      if (attempt === retries) throw error;
    }
  }
}

/** The system under test: the function, over the network, against a counting server; and what must hold wherever it stops. */
export function counting(retries: number) {
  return system(
    {
      client: program((host) => fetchWithRetry(host, 'https://counter.test/add', { retries })),
      net: http({ 'https://counter.test': 'server' }),
      server: mock({ count: 0 }, (state) => [
        { state: { count: state.count + 1 }, response: { status: 200 } },
        { state, response: { status: 500 }, label: 'answers 500', cost: ['server-error'] },
      ]),
    },
    {
      ends: ({ client, server }) => {
        if (client.result === undefined) throw new Error('the client is still running');
        if ('error' in client.result) throw new Error(`the client threw: ${client.result.error}`);
        const { status } = client.result.value as { status: number };
        if (status !== 200) throw new Error(`the client returned ${status}`);
        if (server.state.count < 1) throw new Error('the server never counted');
      },
      // A run has many steps of its own; list the ones charged a fault.
      report: { steps: 'charged' },
    },
  );
}

/** Explore the system within `faults`, and say what was found. */
export async function report(retries: number, faults: number): Promise<string[]> {
  try {
    const { costs, maxDeviationsReached } = await check(counting(retries), { maxDeviations: faults });
    return [`${retries} retries: holds within ${maxDeviationsReached} faults. ${costs.size} states.`];
  } catch (error) {
    if (!(error instanceof ViolationError)) throw error;
    return `${retries} retries: ${error.message}`.split('\n');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log((await report(3, 3)).join('\n'));
  console.log((await report(3, 4)).join('\n'));
}
