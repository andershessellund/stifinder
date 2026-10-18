// ---------------------------------------------------------------------------
// A program part: real code behind the host. The host's fetch, timers,
// signals and randomness; the log, replay and the divergences it catches;
// the late call; and what the value says.
// ---------------------------------------------------------------------------
import { describe, expect, it } from 'vitest';
import { ValueList, deepEqual } from 'valsem';
import { type Host, type LogEntry, type ProgramValue, type Step, SystemError, _drain as drain, program } from './index.js';

/** A step that records what the part sends. */
const recording = () => {
  const sent: { to: string; message: unknown }[] = [];
  const step: Step = { send: (to, message) => void sent.push({ to, message }) };
  return { sent, step };
};

/** A program part started, with what it sent and its value after the start. */
async function started(main: (host: Host) => unknown, options?: Parameters<typeof program>[1]) {
  const kind = program(main, options);
  const runtime = await kind.restore('client', kind.initial('client'));
  const { sent, step } = recording();
  kind.ingest(runtime, 'start', step);
  await drain();
  return { kind, runtime, sent, step, value: () => kind.snapshot(runtime) };
}

const logOf = (value: ProgramValue): readonly LogEntry[] => value.log.toArray();
const url = 'https://api.test/thing';

describe('program: the host', () => {
  it('starting runs main; a fetch is a request sent to the network, as a value, and logged', async () => {
    const { sent, value } = await started((host) => host.fetch(url, { method: 'POST', body: 'hi', headers: { 'x-tag': '1' } }));
    const request = { method: 'POST', url, headers: { 'x-tag': '1' }, body: 'hi' };
    expect(sent).toEqual([{ to: 'net', message: { fetch: request, pos: 0 } }]);
    expect(logOf(value())).toEqual([{ sent: request }]);
    expect(value()).toMatchObject({ started: true });
    expect(value().result).toBeUndefined();
  });

  it('a plain fetch is a GET with no headers and no body; the network to send to is an option', async () => {
    const { sent } = await started((host) => host.fetch(new URL(url)), { network: 'wire' });
    expect(sent).toEqual([{ to: 'wire', message: { fetch: { method: 'GET', url }, pos: 0 } }]);
  });

  it('an answer delivered resolves the request at that position, as a Response; a failure rejects it', async () => {
    const outcomes: string[] = [];
    const main = async (host: Host) => {
      try {
        const response = await host.fetch(url);
        outcomes.push(`${response.status} ${await response.text()} ${response.headers.get('x-h') ?? '-'}`);
      } catch (error) {
        outcomes.push(`error ${(error as Error).message}`);
      }
      try {
        await host.fetch(url);
      } catch (error) {
        outcomes.push(`error ${(error as Error).message}`);
      }
      return outcomes.length;
    };
    const { kind, runtime, step, value } = await started(main);
    kind.receive(runtime, 'net', { pos: 0, response: { status: 201, body: 'made', headers: { 'x-h': 'v' } } }, step);
    await drain();
    kind.receive(runtime, 'net', { pos: 0, error: 'fetch failed: refused' }, step);
    await drain();
    expect(outcomes).toEqual(['201 made v', 'error fetch failed: refused']);
    expect(value().result).toEqual({ value: 2 });
    expect(logOf(value())).toEqual([
      { sent: { method: 'GET', url } },
      { got: { status: 201, body: 'made', headers: { 'x-h': 'v' } }, pos: 0 },
      { sent: { method: 'GET', url } },
      { failed: 'fetch failed: refused', pos: 0 },
    ]);
  });

  it('requests outstanding together settle by position, and the positions above one that settles move down', async () => {
    const { kind, runtime, step, sent, value } = await started((host) => Promise.all([host.fetch(`${url}/a`), host.fetch(`${url}/b`)]).then((r) => r.map((x) => x.status)));
    expect(sent.map((s) => (s.message as { pos: number }).pos)).toEqual([0, 1]);
    kind.receive(runtime, 'net', { pos: 1, response: { status: 202 } }, step);
    await drain();
    expect(value().result).toBeUndefined();
    kind.receive(runtime, 'net', { pos: 0, response: { status: 201 } }, step);
    await drain();
    expect(value().result).toEqual({ value: [201, 202] });
  });

  it('a request that is not a value is the test\'s error, recorded for the system and never thrown into the code', async () => {
    let caught = 'nothing';
    const { kind, runtime, sent } = await started(async (host) => {
      try {
        await host.fetch(url, { method: 'POST', body: new Uint8Array(1) });
      } catch (error) {
        caught = (error as Error).message;
      }
    });
    expect(caught).toBe('nothing');
    expect(sent).toEqual([]);
    expect(() => kind.snapshot(runtime)).toThrow(new SystemError('a request body under program() must be a string: a stream, blob or form is not a value'));
    const other = await started((host) => host.fetch(new Request(url, { method: 'POST', body: 'x' })));
    expect(() => other.kind.snapshot(other.runtime)).toThrow(/a Request with a body under program\(\) is not a value/);
  });

  it('a GET with a body is the code\'s error, as the platform has it', async () => {
    const { value, sent } = await started((host) => host.fetch(url, { body: 'x' }).catch((e: Error) => `${e.name}: ${e.message}`));
    expect(sent).toEqual([]);
    expect(value().result).toEqual({ value: 'TypeError: Request with GET/HEAD method cannot have body' });
  });

  it('an answer no Response can be is the server part\'s error', async () => {
    const { kind, runtime, step } = await started((host) => host.fetch(url));
    expect(() => kind.receive(runtime, 'net', { pos: 0, response: { status: 204, body: '' } }, step)).toThrow(SystemError);
    expect(() => kind.receive(runtime, 'net', { pos: 0, response: { status: 199 } }, step)).toThrow(/an answer with status 199 is not one a Response can be/);
    // The request is still outstanding: nothing was settled by a failed delivery.
    kind.receive(runtime, 'net', { pos: 0, response: { status: 200 } }, step);
    await drain();
    expect(kind.snapshot(runtime).result).toEqual({ value: { status: 200 } });
  });

  it('a fetch with a signal already aborted rejects with its reason, and sends nothing', async () => {
    const { sent, value } = await started((host) => host.fetch(url, { signal: AbortSignal.abort(new Error('gone')) }).catch((e: Error) => e.message));
    expect(sent).toEqual([]);
    expect(value().result).toEqual({ value: 'gone' });
  });
});

describe('program: timers', () => {
  it('timers are distances to fire, in due order and registration order at equal dues; an advance is never expected, firing is', async () => {
    const fired: string[] = [];
    const { kind, runtime, step, value } = await started((host) => {
      host.setTimeout(() => fired.push('a'), 100);
      host.setTimeout(() => fired.push('b'), 50);
      host.setTimeout(() => fired.push('c'), 50);
      host.setTimeout(() => fired.push('d'), 0);
    });
    expect(value().timers.toArray()).toEqual([
      { id: 4, distance: 0 },
      { id: 2, distance: 50 },
      { id: 3, distance: 50 },
      { id: 1, distance: 100 },
    ]);
    expect(kind.events(value())).toEqual([{ event: { fire: 4 }, expected: true }]);
    kind.ingest(runtime, { fire: 4 }, step);
    await drain();
    expect(fired).toEqual(['d']);
    expect(kind.events(value())).toEqual([{ event: { advance: 50 } }, { event: { advance: 100 } }]);
    kind.ingest(runtime, { advance: 50 }, step);
    await drain();
    expect(value().timers.toArray()).toEqual([
      { id: 2, distance: 0 },
      { id: 3, distance: 0 },
      { id: 1, distance: 50 },
    ]);
    kind.ingest(runtime, { fire: 2 }, step);
    kind.ingest(runtime, { fire: 3 }, step);
    kind.ingest(runtime, { advance: 50 }, step);
    kind.ingest(runtime, { fire: 1 }, step);
    await drain();
    expect(fired).toEqual(['d', 'b', 'c', 'a']);
    expect(kind.events(value())).toEqual([]);
    // The advances are not in the log: how time moved is not part of the history.
    expect(logOf(value())).toEqual([{ fired: 4 }, { fired: 2 }, { fired: 3 }, { fired: 1 }]);
    expect(kind.describeEvent?.({ advance: 50 }, value(), 'client')).toBe('client waits 50 ms');
    expect(kind.describeEvent?.({ fire: 1 }, value(), 'client')).toBe('a timer of client fires');
    expect(kind.describeEvent?.('start', value(), 'client')).toBe('client starts');
  });

  it('a cleared timer is gone; an interval comes back at its period until cleared', async () => {
    const fired: number[] = [];
    const { kind, runtime, step, value } = await started((host) => {
      const gone = host.setTimeout(() => fired.push(-1), 10);
      host.clearTimeout(gone);
      let n = 0;
      const every = host.setInterval(() => {
        fired.push(++n);
        if (n === 2) host.clearInterval(every);
      }, 10);
    });
    expect(value().timers.toArray()).toEqual([{ id: 2, distance: 10, interval: 10 }]);
    for (let i = 0; i < 2; i++) {
      kind.ingest(runtime, { advance: 10 }, step);
      kind.ingest(runtime, { fire: 2 }, step);
      await drain();
    }
    expect(fired).toEqual([1, 2]);
    expect(value().timers.toArray()).toEqual([]);
  });

  it('timeoutSignal aborts the fetch when its timer fires: the request is aborted, logged, and the network told', async () => {
    const { kind, runtime, step, sent, value } = await started((host) => host.fetch(url, { signal: host.timeoutSignal(100) }).catch((e: Error) => e.name));
    kind.ingest(runtime, { advance: 100 }, step);
    kind.ingest(runtime, { fire: 1 }, step);
    await drain();
    expect(sent).toEqual([
      { to: 'net', message: { fetch: { method: 'GET', url }, pos: 0 } },
      { to: 'net', message: { abort: 0 } },
    ]);
    expect(logOf(value())).toEqual([{ sent: { method: 'GET', url } }, { fired: 1 }, { aborted: 0 }]);
    expect(value().result).toEqual({ value: 'TimeoutError' });
  });

  it('an answer before the signal fires settles the request, and drops the signal\'s timer with it', async () => {
    const { kind, runtime, step, sent, value } = await started((host) => host.fetch(url, { signal: host.timeoutSignal(100) }).then((r) => r.status));
    expect(value().timers.length).toBe(1);
    kind.receive(runtime, 'net', { pos: 0, response: { status: 200 } }, step);
    await drain();
    expect(value().result).toEqual({ value: 200 });
    expect(value().timers.length).toBe(0);
    expect(sent).toHaveLength(1);
    expect(kind.events(value())).toEqual([]);
  });

  it('a signal of the code\'s own is not dropped: its timer fires, and aborts nobody', async () => {
    const { kind, runtime, step, sent, value } = await started((host) => {
      const controller = new AbortController();
      host.setTimeout(() => controller.abort(), 100);
      return host.fetch(url, { signal: controller.signal }).then((r) => r.status);
    });
    kind.receive(runtime, 'net', { pos: 0, response: { status: 200 } }, step);
    await drain();
    expect(value().timers.length).toBe(1);
    kind.ingest(runtime, { advance: 100 }, step);
    kind.ingest(runtime, { fire: 1 }, step);
    await drain();
    expect(sent).toHaveLength(1);
    expect(value().result).toEqual({ value: 200 });
  });

  it('one timeout signal guarding several requests keeps its timer until the last of them settles', async () => {
    const { kind, runtime, step, sent, value } = await started((host) => {
      const signal = host.timeoutSignal(1000);
      return Promise.all([host.fetch(`${url}/a`, { signal }), host.fetch(`${url}/b`, { signal })]).then(() => 'both', (e: Error) => e.name);
    });
    kind.receive(runtime, 'net', { pos: 0, response: { status: 200 } }, step);
    await drain();
    expect(value().timers.length).toBe(1);
    kind.ingest(runtime, { advance: 1000 }, step);
    kind.ingest(runtime, { fire: 1 }, step);
    await drain();
    expect(sent.at(-1)).toEqual({ to: 'net', message: { abort: 0 } });
    expect(value().result).toEqual({ value: 'TimeoutError' });
    expect(value().timers.length).toBe(0);
  });

  it('histories that differ only in how time moved are one state', async () => {
    const main = (host: Host) => {
      host.setTimeout(() => undefined, 10);
      host.setTimeout(() => undefined, 20);
    };
    const one = await started(main);
    one.kind.ingest(one.runtime, { advance: 20 }, one.step);
    one.kind.ingest(one.runtime, { fire: 1 }, one.step);
    one.kind.ingest(one.runtime, { fire: 2 }, one.step);
    const two = await started(main);
    two.kind.ingest(two.runtime, { advance: 10 }, two.step);
    two.kind.ingest(two.runtime, { fire: 1 }, two.step);
    two.kind.ingest(two.runtime, { advance: 10 }, two.step);
    two.kind.ingest(two.runtime, { fire: 2 }, two.step);
    await drain();
    expect(deepEqual(one.value(), two.value())).toBe(true);
  });
});

describe('program: replay', () => {
  const retrying = async (host: Host) => {
    for (;;) {
      try {
        const response = await host.fetch(url);
        if (response.ok) return response.status;
      } catch {
        // try again
      }
    }
  };

  it('restore runs main again with the log replayed, and the runtime goes on from there', async () => {
    const { kind, runtime, step, value } = await started(retrying);
    kind.receive(runtime, 'net', { pos: 0, error: 'fetch failed' }, step);
    await drain();
    kind.receive(runtime, 'net', { pos: 0, response: { status: 500 } }, step);
    await drain();
    const before = value();
    expect(logOf(before)).toHaveLength(5);

    const rebuilt = await kind.restore('client', before);
    expect(deepEqual(kind.snapshot(rebuilt), before)).toBe(true);
    const { sent, step: later } = recording();
    kind.receive(rebuilt, 'net', { pos: 0, response: { status: 200 } }, later);
    await drain();
    expect(sent).toEqual([]);
    expect(kind.snapshot(rebuilt).result).toEqual({ value: 200 });
  });

  it('restore sets the timers from the value, by id, whatever the advances were', async () => {
    const fired: number[] = [];
    const { kind, runtime, step, value } = await started((host) => {
      host.setTimeout(() => fired.push(1), 100);
      host.setTimeout(() => fired.push(2), 30);
      host.setTimeout(() => fired.push(3), 50);
    });
    kind.ingest(runtime, { advance: 30 }, step);
    kind.ingest(runtime, { fire: 2 }, step);
    kind.ingest(runtime, { advance: 10 }, step);
    await drain();
    const before = value();
    expect(before.timers.toArray()).toEqual([
      { id: 3, distance: 10 },
      { id: 1, distance: 60 },
    ]);
    const rebuilt = await kind.restore('client', before);
    expect(deepEqual(kind.snapshot(rebuilt), before)).toBe(true);
    const later = recording();
    kind.ingest(rebuilt, { advance: 10 }, later.step);
    expect(kind.events(kind.snapshot(rebuilt))).toEqual([{ event: { fire: 3 }, expected: true }]);
  });

  it('a value not started restores to a runtime not started', async () => {
    const kind = program(retrying);
    const runtime = await kind.restore('client', kind.initial('client'));
    expect(kind.snapshot(runtime)).toEqual({ started: false, log: ValueList.empty(), timers: ValueList.empty() });
  });

  it('code that departs from its log is a SystemError from restore, recorded by the host, not thrown into the code', async () => {
    const { kind, value } = await started(async (host) => {
      for (;;) {
        try {
          return await host.fetch(`${url}/${Math.random()}`);
        } catch {
          // a throw into the code would be swallowed here
        }
      }
    });
    await expect(kind.restore('client', value())).rejects.toThrow(SystemError);
    await expect(kind.restore('client', value())).rejects.toThrow(
      /^stifinder: client diverged on replay: it tried to send GET https:\/\/api\.test\/thing\/0\.\d+, where the log has it send GET https:\/\/api\.test\/thing\/0\.\d+\. The code is not a function of its inputs$/,
    );
  });

  it('code that makes fewer calls on replay than the log has is a divergence too', async () => {
    let calls = 0;
    const { kind, value } = await started((host) => (calls++ === 0 ? host.fetch(url) : undefined));
    await expect(kind.restore('client', value())).rejects.toThrow(/client diverged on replay: it did not send GET https:\/\/api\.test\/thing, as the log has it/);
  });

  it('the host\'s random and uuid are a seeded stream, the same on replay, so a draw in a request replays', async () => {
    const draws: unknown[] = [];
    const main = (host: Host) => {
      draws.push(host.random(), host.uuid());
      return host.fetch(`${url}/${host.random()}`, { headers: { 'idempotency-key': host.uuid() } });
    };
    const { kind, value, sent } = await started(main);
    const first = draws.splice(0);
    expect(first[1]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const rebuilt = await kind.restore('client', value());
    expect(draws).toEqual(first);
    expect(deepEqual(kind.snapshot(rebuilt), value())).toBe(true);
    const other = await started(main, { seed: 2 });
    expect(other.sent).not.toEqual(sent);
  });

  it('a host call after the step is over is the test\'s error: recorded for the system, raised at the next step, never thrown into the code', async () => {
    let settled = 'no';
    const { kind, runtime, step, value } = await started((host) => {
      setTimeout(() => {
        void host.fetch(url).then(
          () => (settled = 'resolved'),
          () => (settled = 'rejected'),
        );
      }, 1);
    });
    const before = value();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe('no');
    const late = /client called its host after its step was over: work left on the macrotask queue, a real timer above all, is not part of the model/;
    expect(kind.fault?.()).toBeInstanceOf(SystemError);
    expect(kind.fault?.()?.message).toMatch(late);
    expect(() => kind.ingest(runtime, { advance: 1 }, step)).toThrow(late);
    await expect(kind.restore('client', before)).rejects.toThrow(late);
  });

  it('a late abort from the code\'s own timer rejects the code\'s promise, and is recorded, not thrown out of the listener', async () => {
    let outcome = 'pending';
    const { kind, value } = await started((host) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('late')), 1);
      return host.fetch(url, { signal: controller.signal }).then(
        () => (outcome = 'resolved'),
        (e: Error) => (outcome = e.message),
      );
    });
    value(); // the step is over
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outcome).toBe('late');
    expect(kind.fault?.()?.message).toMatch(/after its step was over/);
  });

  it('two parts draw different random streams, and the same part the same one on every run', async () => {
    const draws = new Map<string, number[]>();
    const kind = program((host) => {
      draws.set(host.uuid().slice(0, 8), [host.random(), host.random()]);
    });
    for (const id of ['alice', 'bob', 'alice']) {
      const runtime = await kind.restore(id, kind.initial(id));
      kind.ingest(runtime, 'start', recording().step);
    }
    await drain();
    expect(draws.size).toBe(2);
    const [a, b] = [...draws.values()];
    expect(a).not.toEqual(b);
  });
});

describe('program: the value', () => {
  it('says what main settled with: a Response by its status, a throw by its message, nothing as null', async () => {
    const response = await started(() => new Response(null, { status: 204 }));
    expect(response.value().result).toEqual({ value: { status: 204 } });
    const thrown = await started(() => {
      throw new Error('boom');
    });
    expect(thrown.value().result).toEqual({ error: 'boom' });
    const rejected = await started(() => Promise.reject(new TypeError('later')));
    expect(rejected.value().result).toEqual({ error: 'later' });
    const nothing = await started(() => undefined);
    expect(nothing.value().result).toEqual({ value: null });
  });

  it('reads as what it is doing, with its timers', async () => {
    const kind = program(() => undefined);
    expect(kind.describeValue?.(kind.initial('client'), 'client')).toBe('not started');
    const running = await started((host) =>
      host.fetch(url).then(() => {
        host.setTimeout(() => undefined, 5);
      }),
    );
    expect(kind.describeValue?.(running.value(), 'client')).toBe('running');
    running.kind.receive(running.runtime, 'net', { pos: 0, response: { status: 200 } }, running.step);
    await drain();
    expect(kind.describeValue?.(running.value(), 'client')).toBe('returned null, 1 timer pending');
    const thrown = await started(() => Promise.reject(new Error('no')));
    expect(kind.describeValue?.(thrown.value(), 'client')).toBe('threw no');
  });

  it('something delivered that is not an answer or a failure is a SystemError', async () => {
    const { kind, runtime, step } = await started((host) => host.fetch(url));
    expect(() => kind.receive(runtime, 'net', { nonsense: true }, step)).toThrow(SystemError);
    expect(() => kind.receive(runtime, 'net', { pos: 3, response: { status: 200 } }, step)).toThrow(
      new SystemError('client has no outstanding request 3 to get a 200 answer to request 3'),
    );
  });
});
