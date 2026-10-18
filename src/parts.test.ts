// ---------------------------------------------------------------------------
// The network and the mock: routing, positions and their shifts, the faults,
// orphans; then real code over both, and the second oracle: a client written
// as a value part reaches the same states, and finds the same violation, as
// the same client written as real code behind the host, up to the log.
// ---------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import {
  type Host,
  type HttpValue,
  type Step,
  type SystemState,
  type ToProgram,
  IncompleteError,
  SystemError,
  ViolationError,
  check,
  exploreIteratively,
  http,
  mock,
  partsOf,
  program,
  system,
  valuePart,
} from './index.js';

const recording = () => {
  const sent: { to: string; message: unknown }[] = [];
  const step: Step = { send: (to, message) => void sent.push({ to, message }) };
  return { sent, step };
};
const get = (url: string) => ({ method: 'GET', url });
const base = 'https://counter.test';

describe('mock', () => {
  const counter = mock({ count: 0 }, (state, request) =>
    request.url.endsWith('/boom')
      ? { state, response: { status: 400 }, label: 'refuses' }
      : [
          { state: { count: state.count + 1 }, response: { status: 200, body: String(state.count + 1) } },
          { state, response: { status: 500 }, label: 'answers 500', cost: ['server-error'] },
        ],
  );

  it('a delivered request is pending; the outcomes of the oldest are its events, the first expected, with their costs', async () => {
    const cell = await counter.restore('server', counter.initial('server'));
    expect(counter.events(cell.value)).toEqual([]);
    counter.receive(cell, 'net', { request: get(`${base}/add`) }, recording().step);
    counter.receive(cell, 'net', { request: get(`${base}/boom`) }, recording().step);
    expect(cell.value.pending).toHaveLength(2);
    expect(counter.events(cell.value)).toEqual([
      { event: 0, expected: true },
      { event: 1, expected: false, cost: ['server-error'] },
    ]);
    const { sent, step } = recording();
    counter.ingest(cell, 1, step);
    expect(sent).toEqual([{ to: 'net', message: { respond: { status: 500 } } }]);
    expect(counter.snapshot(cell)).toEqual({ state: { count: 0 }, pending: [{ request: get(`${base}/boom`), from: 'net' }] });
    expect(counter.events(cell.value)).toEqual([{ event: 0, expected: true }]);
    counter.ingest(cell, 0, step);
    expect(sent[1]).toEqual({ to: 'net', message: { respond: { status: 400 } } });
    expect(counter.events(cell.value)).toEqual([]);
  });

  it('reads by its labels and its state', async () => {
    const cell = await counter.restore('server', counter.initial('server'));
    counter.receive(cell, 'net', { request: get(`${base}/add`) }, recording().step);
    expect(counter.describeEvent?.(0, cell.value, 'server')).toBe('server answers 200');
    expect(counter.describeEvent?.(1, cell.value, 'server')).toBe('server answers 500');
    expect(counter.describeValue?.(cell.value, 'server')).toBe('{"count":0}, 1 pending');
  });

  it('what is not a request, an outcome it does not have, and a handle that returns none are SystemErrors', async () => {
    const cell = await counter.restore('server', counter.initial('server'));
    expect(() => counter.receive(cell, 'net', 'hello', recording().step)).toThrow(SystemError);
    expect(() => counter.ingest(cell, 0, recording().step)).toThrow(SystemError);
    const none = mock(0, () => []);
    const empty = await none.restore('server', none.initial('server'));
    none.receive(empty, 'net', { request: get(base) }, recording().step);
    expect(() => none.events(empty.value)).toThrow(new SystemError(`a mock's handle returned no outcome for GET ${base}`));
  });
});

describe('http', () => {
  const net = http({ [base]: 'server', 'https://other.test': 'other' });
  const fresh = async () => net.restore('net', net.initial('net'));
  /** A client's request, sent, then delivered, then answered: the answer in flight. */
  const answered = (cell: { value: HttpValue }, status: number) => {
    const { step } = recording();
    net.ingest(cell, { deliver: 0 }, step);
    net.receive(cell, 'server', { respond: { status } }, step);
  };

  it('routes a request by prefix, and delivers oldest first, expecting the oldest', async () => {
    const cell = await fresh();
    const { sent, step } = recording();
    net.receive(cell, 'client', { fetch: get(`${base}/add`), pos: 0 }, step);
    net.receive(cell, 'client', { fetch: get('https://other.test/x'), pos: 1 }, step);
    expect(net.events(cell.value)).toEqual([
      { event: { deliver: 0 }, expected: true },
      { event: { deliver: 1 }, expected: false },
      { event: { lose: 0 }, cost: ['loss'] },
      { event: { lose: 1 }, cost: ['loss'] },
      { event: { fail: 0 }, cost: ['failure'] },
      { event: { fail: 1 }, cost: ['failure'] },
    ]);
    net.ingest(cell, { deliver: 1 }, step);
    expect(sent).toEqual([{ to: 'other', message: { request: get('https://other.test/x') } }]);
    expect(cell.value.inProgress).toEqual({ other: [{ client: 'client', pos: 1 }] });
    expect(cell.value.inFlight).toHaveLength(1);
  });

  it('an answer goes to the client at its position; the positions above one that settles move down, in flight and in progress', async () => {
    const cell = await fresh();
    const { sent, step } = recording();
    net.receive(cell, 'client', { fetch: get(`${base}/a`), pos: 0 }, step);
    net.receive(cell, 'client', { fetch: get(`${base}/b`), pos: 1 }, step);
    net.receive(cell, 'client', { fetch: get(`${base}/c`), pos: 2 }, step);
    net.ingest(cell, { deliver: 0 }, step);
    net.ingest(cell, { deliver: 0 }, step);
    net.receive(cell, 'server', { respond: { status: 200 } }, step);
    // In flight: c's request (pos 2), the answer to a (pos 0). In progress: b (pos 1).
    net.ingest(cell, { deliver: 1 }, step);
    expect(sent.at(-1)).toEqual({ to: 'client', message: { pos: 0, response: { status: 200 } } });
    expect(cell.value).toEqual({
      inFlight: [{ kind: 'request', client: 'client', pos: 1, server: 'server', request: get(`${base}/c`) }],
      inProgress: { server: [{ client: 'client', pos: 0 }] },
    });
  });

  it('a lost message is silence; a failed connection is told to the client, before delivery and after', async () => {
    const cell = await fresh();
    const { sent, step } = recording();
    net.receive(cell, 'client', { fetch: get(`${base}/a`), pos: 0 }, step);
    net.ingest(cell, { lose: 0 }, step);
    expect(sent).toEqual([]);
    expect(cell.value).toEqual({ inFlight: [], inProgress: {} });

    net.receive(cell, 'client', { fetch: get(`${base}/a`), pos: 0 }, step);
    net.ingest(cell, { fail: 0 }, step);
    expect(sent).toEqual([{ to: 'client', message: { pos: 0, error: `fetch failed: the connection for GET ${base}/a was refused` } }]);

    net.receive(cell, 'client', { fetch: get(`${base}/a`), pos: 0 }, step);
    answered(cell, 200);
    net.ingest(cell, { fail: 0 }, step);
    expect(sent[1]).toEqual({ to: 'client', message: { pos: 0, error: 'fetch failed: the connection was reset before the 200 answer arrived' } });
    expect(cell.value).toEqual({ inFlight: [], inProgress: {} });
  });

  it('a request the client gave up on is an orphan: delivered like any, never failed, and its answer goes nowhere', async () => {
    const cell = await fresh();
    const { sent, step } = recording();
    net.receive(cell, 'client', { fetch: get(`${base}/a`), pos: 0 }, step);
    net.receive(cell, 'client', { fetch: get(`${base}/b`), pos: 1 }, step);
    net.receive(cell, 'client', { abort: 0 }, step);
    expect(cell.value.inFlight).toEqual([
      { kind: 'request', client: 'client', pos: null, server: 'server', request: get(`${base}/a`) },
      { kind: 'request', client: 'client', pos: 0, server: 'server', request: get(`${base}/b`) },
    ]);
    expect(net.events(cell.value).map(({ event }) => event)).toEqual([{ deliver: 0 }, { deliver: 1 }, { lose: 0 }, { lose: 1 }, { fail: 1 }]);
    net.ingest(cell, { deliver: 0 }, step);
    expect(sent).toEqual([{ to: 'server', message: { request: get(`${base}/a`) } }]);
    expect(cell.value.inProgress).toEqual({ server: [null] });
    net.receive(cell, 'server', { respond: { status: 200 } }, step);
    expect(cell.value).toEqual({ inFlight: [{ kind: 'request', client: 'client', pos: 0, server: 'server', request: get(`${base}/b`) }], inProgress: {} });
  });

  it('giving up on a request in progress orphans it there, and on an answer in flight drops the answer', async () => {
    const cell = await fresh();
    const { step } = recording();
    net.receive(cell, 'client', { fetch: get(`${base}/a`), pos: 0 }, step);
    net.ingest(cell, { deliver: 0 }, step);
    net.receive(cell, 'client', { abort: 0 }, step);
    expect(cell.value.inProgress).toEqual({ server: [null] });

    net.receive(cell, 'client', { fetch: get(`${base}/b`), pos: 0 }, step);
    net.ingest(cell, { deliver: 0 }, step);
    net.receive(cell, 'server', { respond: { status: 200 } }, step);
    net.receive(cell, 'server', { respond: { status: 200 } }, step);
    expect(cell.value.inFlight).toEqual([{ kind: 'response', client: 'client', pos: 0, response: { status: 200 } }]);
    net.receive(cell, 'client', { abort: 0 }, step);
    expect(cell.value).toEqual({ inFlight: [], inProgress: {} });
  });

  it('a URL is routed to the longest route it is under, not to a route it merely starts with', async () => {
    const routed = http({ 'https://api.test': 'short', 'https://api.test/v2': 'long', 'https://api.testing.com/': 'other' });
    const where = async (url: string) => {
      const cell = await routed.restore('net', routed.initial('net'));
      routed.receive(cell, 'client', { fetch: get(url), pos: 0 }, recording().step);
      return (cell.value.inFlight[0] as { server: string }).server;
    };
    expect(await where('https://api.test')).toBe('short');
    expect(await where('https://api.test/v1/x')).toBe('short');
    expect(await where('https://api.test?x=1')).toBe('short');
    expect(await where('https://api.test/v2')).toBe('long');
    expect(await where('https://api.test/v2/things')).toBe('long');
    expect(await where('https://api.test/v22')).toBe('short');
    expect(await where('https://api.testing.com/x')).toBe('other');
    await expect(where('https://api.testing.org/x')).rejects.toThrow(SystemError);
  });

  it('no route, an answer with nothing in progress, and a message it does not understand are SystemErrors', async () => {
    const cell = await fresh();
    const { step } = recording();
    expect(() => net.receive(cell, 'client', { fetch: get('https://nowhere.test/'), pos: 0 }, step)).toThrow(
      new SystemError('http has no route for https://nowhere.test/; its routes are "https://counter.test", "https://other.test"'),
    );
    expect(() => net.receive(cell, 'server', { respond: { status: 200 } }, step)).toThrow(new SystemError('server answered with no request in progress'));
    expect(() => net.receive(cell, 'server', 42, step)).toThrow(SystemError);
  });

  it('reads by what is in flight and in progress', async () => {
    const cell = await fresh();
    const { step } = recording();
    expect(net.describeValue?.(cell.value, 'net')).toBe('nothing in flight');
    net.receive(cell, 'client', { fetch: get(`${base}/a`), pos: 0 }, step);
    net.receive(cell, 'client', { fetch: get(`${base}/b`), pos: 1 }, step);
    expect(net.describeEvent?.({ deliver: 1 }, cell.value, 'net')).toBe("client's request 1 is delivered");
    expect(net.describeEvent?.({ lose: 0 }, cell.value, 'net')).toBe("client's request is lost");
    net.ingest(cell, { deliver: 0 }, step);
    net.receive(cell, 'server', { respond: { status: 200 } }, step);
    expect(net.describeEvent?.({ fail: 1 }, cell.value, 'net')).toBe('the connection fails, and the 200 answer to client never arrives');
    expect(net.describeValue?.(cell.value, 'net')).toBe("in flight: client's request 1, the 200 answer to client");
    net.receive(cell, 'client', { fetch: get(`${base}/c`), pos: 2 }, step);
    net.ingest(cell, { deliver: 2 }, step);
    expect(net.describeValue?.(cell.value, 'net')).toBe("in flight: client's request 1, the 200 answer to client; 1 in progress at server");
  });
});

// ---------------------------------------------------------------------------
// Real code over the network and a mock.
// ---------------------------------------------------------------------------

/** The code under test: fetch, and try again after an error answer or a failed connection, up to `retries` more times. */
async function fetchWithRetry(fetch: Host['fetch'], url: string, retries: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok || attempt === retries) return response;
    } catch (error) {
      if (attempt === retries) throw error;
    }
  }
}

const counting = () =>
  mock({ count: 0 }, (state) => [
    { state: { count: state.count + 1 }, response: { status: 200 } },
    { state, response: { status: 500 }, label: 'answers 500', cost: ['server-error'] },
  ]);

const retrying = (retries: number) =>
  system(
    { client: program(({ fetch }) => fetchWithRetry(fetch, `${base}/add`, retries)), net: http({ [base]: 'server' }), server: counting() },
    {
      ends: ({ client, server }) => {
        expect(client.result).toEqual({ value: { status: 200 } });
        expect(server.state.count).toBeGreaterThanOrEqual(1);
      },
    },
  );

describe('real code over http and a mock', () => {
  // This client has no timeout, so a lost message, which is silence, hangs it: the budgets below leave losses out.
  it('gets an ok answer within as many faults as it retries, and the server counted', async () => {
    const space = await check(retrying(3), { maxDeviations: 3, baseBudget: { loss: 0 } });
    expect(space.maxDeviationsReached).toBe(3);
    expect(space.exhaustive).toBe(false);
  });

  it('gives up one fault later, and the report says how', async () => {
    const error = await check(retrying(3), { maxDeviations: 4, baseBudget: { loss: 0 } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViolationError);
    expect((error as ViolationError).message.split('\n')).toEqual([
      'expected { Object (error) } to deeply equal { value: { status: 200 } }',
      '4 deviations, 5 steps, failure: 4',
      '  1. client starts',
      "  2. the connection fails, and client's request never arrives  (deviation, failure)",
      "  3. the connection fails, and client's request never arrives  (deviation, failure)",
      "  4. the connection fails, and client's request never arrives  (deviation, failure)",
      "  5. the connection fails, and client's request never arrives  (deviation, failure)",
      `in state: client: threw fetch failed: the connection for GET ${base}/add was refused; net: nothing in flight; server: {"count":0}`,
    ]);
  });

  it('a lost message is silence, and a client without a timeout waits for it forever: the system stops with the client running', async () => {
    const error = await check(retrying(3)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViolationError);
    expect((error as ViolationError).message.split('\n')).toEqual([
      'expected undefined to deeply equal { value: { status: 200 } }',
      '1 deviation, 2 steps, loss: 1',
      '  1. client starts',
      "  2. client's request is lost  (deviation, loss)",
      'in state: client: running; net: nothing in flight; server: {"count":0}',
    ]);
  });

  it('a client that never gives up has no end to its space: a fault bound is what makes the search finite', async () => {
    await expect(check(retrying(Infinity), { baseBudget: { loss: 0 }, maxEdges: 400 })).rejects.toThrow(IncompleteError);
  });

  it('code that draws a random number is caught at its first replay', async () => {
    const model = system({
      client: program(({ fetch }) => fetchWithRetry(fetch, `${base}/${Math.random()}`, 1)),
      net: http({ [base]: 'server' }),
      server: counting(),
    });
    await expect(check(model)).rejects.toThrow(/^stifinder: client diverged on replay: it tried to send GET https:\/\/counter\.test\/0\.\d+/);
  });

  it('two requests in flight at once come back to the right promises whatever the order', async () => {
    const model = system(
      {
        client: program(({ fetch }) => Promise.all([fetch(`${base}/a`), fetch(`${base}/b`)]).then((r) => r.map((x) => x.status))),
        net: http({ [base]: 'server' }),
        server: mock(0, (state, request) => ({ state, response: { status: request.url.endsWith('/a') ? 201 : 202 } })),
      },
      { ends: ({ client }) => expect(client.result).toEqual({ value: [201, 202] }) },
    );
    const space = await check(model, { baseBudget: { loss: 0, failure: 0 } });
    expect(space.completed).toBe(true);
    expect(space.violation).toBeNull();
  });

  it('one deadline over requests made one after another times out the later one too', async () => {
    const model = system(
      {
        client: program(async ({ fetch, timeoutSignal }) => {
          const signal = timeoutSignal(1000);
          if (!(await fetch(`${base}/a`, { signal }).then(() => true, () => false))) return 'gave up';
          return fetch(`${base}/b`, { signal }).then(
            () => 'ok',
            () => 'b timed out',
          );
        }),
        net: http({ [base]: 'server' }),
        server: mock(0, (state) => ({ state, response: { status: 200 } })),
      },
      { ends: ({ client }) => expect(client.result).not.toEqual({ value: 'b timed out' }) },
    );
    const error = await check(model, { baseBudget: { loss: 0, failure: 0 } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ViolationError);
    expect((error as ViolationError).message).toMatch(/in state: client: returned b timed out/);
  });

  it('a request timed out by the host is aborted on the network, and the retry is a new request', async () => {
    const model = system(
      {
        client: program(async ({ fetch, timeoutSignal }) => {
          for (;;) {
            try {
              return (await fetch(`${base}/add`, { signal: timeoutSignal(100) })).status;
            } catch {
              // try again
            }
          }
        }),
        net: http({ [base]: 'server' }),
        server: counting(),
      },
      { ends: ({ client }) => expect(client.result).toEqual({ value: 200 }) },
    );
    const space = await check(model, { maxDeviations: 2, baseBudget: { failure: 0, 'server-error': 0 } });
    expect(space.maxDeviationsReached).toBe(2);
    const seen = [...space.costs.keys()].map((state) => model.describeState!(state));
    // A lost request, the timeout, the retry: the first request's abort reaches the network with nothing left of it.
    expect(seen.some((text) => text.includes('the request client gave up on'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The second oracle: the retrying client as a value part, and as real
// code behind the host, explore the same product up to the log.
// ---------------------------------------------------------------------------

type Outcome = 'ok' | 'error';
interface ValueClient {
  phase: 'idle' | 'waiting' | 'done';
  sent: number;
  outcome?: Outcome;
}
const valueClient = (retries: number) =>
  valuePart<ValueClient, 'send'>({
    initial: () => ({ phase: 'idle', sent: 0 }),
    events: (value) => (value.phase === 'idle' ? [{ event: 'send', expected: true }] : []),
    ingest(cell, _event, step) {
      cell.value = { phase: 'waiting', sent: 1 };
      step.send('net', { fetch: get(`${base}/add`), pos: 0 });
    },
    receive(cell, _from, message, step) {
      const answer = message as ToProgram;
      const ok = 'response' in answer && answer.response.status === 200;
      if (ok) cell.value = { phase: 'done', sent: cell.value.sent, outcome: 'ok' };
      else if (cell.value.sent === retries + 1) cell.value = { phase: 'done', sent: cell.value.sent, outcome: 'error' };
      else {
        cell.value = { phase: 'waiting', sent: cell.value.sent + 1 };
        step.send('net', { fetch: get(`${base}/add`), pos: 0 });
      }
    },
  });

/** A state of either system, up to the log: what the client sent and got, what is in flight, what the server counted. */
function project(state: SystemState): string {
  const values = partsOf(state);
  const client = values.get('client') as ValueClient | { started: boolean; log: { toArray(): unknown[] }; result?: { value?: { status?: number } } | { error: string } };
  const net = values.get('net') as HttpValue;
  const server = values.get('server') as { state: { count: number }; pending: unknown[] };
  const view =
    'phase' in client
      ? { done: client.phase === 'done', sent: client.sent, outcome: client.outcome ?? null }
      : {
          done: client.result !== undefined,
          sent: client.log.toArray().filter((entry) => typeof entry === 'object' && entry !== null && 'sent' in entry).length,
          outcome: client.result === undefined ? null : 'value' in client.result && client.result.value?.status === 200 ? 'ok' : 'error',
        };
  return JSON.stringify({
    client: view,
    net: net.inFlight.map((leg) => (leg.kind === 'request' ? `req@${leg.pos}` : `res${leg.response.status}@${leg.pos}`)),
    progress: Object.values(net.inProgress).map((list) => list.length),
    server: [server.state.count, server.pending.length],
  });
}

describe('the second oracle: a value part and the same client as real code', () => {
  for (const retries of [1, 2]) {
    it(`explore the same product with ${retries} retries, at every deviation bound, with and without the property`, async () => {
      for (const maxDeviations of [1, 2, 3]) {
        for (const property of [false, true]) {
          const options = property
            ? {
                ends: (values: { server: { state: { count: number } } }) => (values.server.state.count === 0 ? { error: 'never counted' } : undefined),
              }
            : {};
          const asValue = system({ client: valueClient(retries), net: http({ [base]: 'server' }), server: counting() }, options);
          const asCode = system(
            { client: program(({ fetch }) => fetchWithRetry(fetch, `${base}/add`, retries)), net: http({ [base]: 'server' }), server: counting() },
            options,
          );
          const a = await exploreIteratively(asValue, { maxDeviations });
          const b = await exploreIteratively(asCode, { maxDeviations });
          const label = `retries ${retries}, maxDeviations ${maxDeviations}, property ${property}`;
          // Not compared: `exhaustive` and the cost frontier. The log keeps apart arrivals the value part merges, and a
          // costlier arrival at a state of its own carries edges past the bound that the merged state's cheaper arrival
          // explored within it. The paths are the same, so the states reached and the least violation are.
          const states = (space: typeof a) => new Set([...space.costs.keys()].map(project));
          expect(states(b), label).toEqual(states(a));
          expect(b.violation === null, label).toBe(a.violation === null);
          if (a.violation !== null && b.violation !== null) {
            expect([...b.violation.cost.entries()].sort(), label).toEqual([...a.violation.cost.entries()].sort());
            expect(b.violation.steps.map((step) => project(step.state)), label).toEqual(a.violation.steps.map((step) => project(step.state)));
          }
        }
      }
    }, 60_000);
  }
});
