// ---------------------------------------------------------------------------
// A program part: real code behind a host, as a part of a system.
//
// The code is `main(host)`, run for real; the host is the simulated
// platform it takes `fetch`, its timers and its randomness from. The part's
// value is the log of what the host delivered and took, in order — the
// answers and failures of its requests, its timers firing, its clock
// moving, the requests it sent and aborted — with its pending timers as
// distances to fire, and what `main` settled with once it has. Its runtime
// is the code, running: `restore` runs `main` again with the log replayed,
// inputs fed back and outputs compared with the log, and the system
// resumes the live runtime where the value matches.
//
// Time is local and relative: a timer is a distance to fire, an advance
// subtracts, and the clock is never read. The part expects to fire the
// head of its due queue; its other events are advances to its pending
// timers' distances, never expected, since time proceeds only when nothing
// else can happen. A `timeoutSignal`'s timer is dropped once the request it
// guarded has settled: the platform does not wait for such a timer, and it
// could then only abort a signal nobody listens to. Randomness is a seeded
// stream, so a replay draws the same numbers and no draw is logged.
//
// A difference on replay is recorded by the host and raised by `restore`
// once the drain is over: it is not thrown into the code, which may catch
// it. A host call after the step is over — from a real timer above all —
// is the test's error too, raised at the part's next step.
//
// Why: DECISIONS.md D41, D42.
// ---------------------------------------------------------------------------

import { ValueList, deepEqual } from 'valsem';
import type { Host, Timer } from './host.js';
import { type Kind, type Step, SystemError, _drain, _plain } from './system.js';

/** A request as a value, which is how it crosses a part boundary. */
export interface RequestValue {
  method: string;
  url: string;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
}

/** An answer as a value. */
export interface ResponseValue {
  status: number;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
}

/** What a program part sends to the network: a request, as its client's
 *  outstanding request `pos`, or that it gave up on one. */
export type ToNetwork = { fetch: RequestValue; pos: number } | { abort: number };

/** What the network delivers to a program part: the answer to its
 *  outstanding request `pos`, or that the connection for it failed. */
export type ToProgram = { pos: number; response: ResponseValue } | { pos: number; error: string };

/** One thing the host delivered (an input) or took (an output), in order. */
export type LogEntry =
  | { sent: RequestValue }
  | { aborted: number }
  | { got: ResponseValue; pos: number }
  | { failed: string; pos: number }
  | { fired: number }
  | { advanced: number };

/** A pending timer: how far it is from firing, and its period if it repeats. */
export interface TimerValue {
  distance: number;
  interval?: number | undefined;
}

/** What `main` settled with: its value, a `Response` by its status, or its error's message. */
export type Settled = { value: unknown } | { error: string };

export interface ProgramValue {
  started: boolean;
  log: ValueList<LogEntry>;
  /** Pending timers in the order they fire: by distance, then by registration. */
  timers: ValueList<TimerValue>;
  result?: Settled | undefined;
}

/** Start; fire the due timer at index `fire` of `timers`; move the clock by `advance`. */
export type ProgramEvent = 'start' | { fire: number } | { advance: number };

export interface ProgramOptions {
  /** The id of the network part `fetch` sends to. Default: `'net'`. */
  network?: string | undefined;
  /** The seed of the host's random stream. Default: 1. */
  seed?: number | undefined;
}

declare const brand: unique symbol;
/** The runtime of a program part: the code, running. Opaque. */
export interface ProgramRuntime {
  readonly [brand]: 'ProgramRuntime';
}

const describeEntry = (entry: LogEntry): string => {
  if ('sent' in entry) return `send ${entry.sent.method} ${entry.sent.url}`;
  if ('aborted' in entry) return `abort its request ${entry.aborted}`;
  if ('got' in entry) return `get a ${entry.got.status} answer to request ${entry.pos}`;
  if ('failed' in entry) return `fail request ${entry.pos}`;
  if ('fired' in entry) return `fire timer ${entry.fired}`;
  return `advance ${entry.advanced} ms`;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What `main` resolved with, as a value: a `Response` by its status, nothing as null. */
const resultValue = (value: unknown): unknown => (value instanceof Response ? { status: value.status } : value === undefined ? null : value);

/** The request as a value. A body must be a string: the rest are not values. */
function requestValue(input: string | URL | Request, init: RequestInit | undefined): RequestValue {
  const body = init?.body;
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new SystemError('a request body under program() must be a string: a stream, blob or form is not a value');
  }
  if (input instanceof Request && input.body !== null) throw new SystemError('a Request with a body under program() is not a value: pass the body as a string in init');
  const request = new Request(input, { ...init, body: null });
  const headers = Object.fromEntries(request.headers);
  const value: RequestValue = { method: request.method, url: request.url };
  if (Object.keys(headers).length > 0) value.headers = headers;
  if (typeof body === 'string') value.body = body;
  return value;
}

const toResponse = (value: ResponseValue): Response => new Response(value.body ?? null, { status: value.status, headers: value.headers });

/** A seeded random stream (mulberry32). */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A version-4 UUID from the stream. */
function uuidFrom(random: () => number): string {
  const hex = Array.from({ length: 8 }, () => Math.floor(random() * 0x10000).toString(16).padStart(4, '0')).join('');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A delay as the host keeps it: whole milliseconds, none below zero. */
const delayOf = (ms: number): number => (Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0);

interface Pending {
  resolve(response: Response): void;
  reject(error: unknown): void;
  /** Once settled: stops listening for an abort, and drops a timeout signal's timer. */
  cleanup?: () => void;
}

interface PendingTimer {
  id: number;
  callback: () => void;
  distance: number;
  interval: number | undefined;
}

/** The code, running, and the host it runs against. */
class Runtime {
  started = false;
  log = ValueList.empty<LogEntry>();
  timers: PendingTimer[] = [];
  result: Settled | undefined;
  /** The requests the code waits on, in the order it made them. */
  readonly outstanding: Pending[] = [];
  /** The step this runtime is live in; undefined between steps, and on replay. */
  step: Step | undefined;
  /** Set on replay: the log, and how far along it is. */
  replay: { log: readonly LogEntry[]; at: number } | undefined;
  /** How the code departed from the log on replay, recorded, not thrown. */
  divergence: string | undefined;
  readonly host: Host;
  private nextTimer = 1;
  private readonly random: () => number;
  /** The timer behind each `timeoutSignal`, to drop with the request it guarded. */
  private readonly guards = new WeakMap<AbortSignal, number>();

  constructor(
    readonly id: string,
    private readonly main: (host: Host) => unknown,
    private readonly network: string,
    seed: number,
    private readonly onLate: (error: SystemError) => void,
  ) {
    this.random = mulberry32(seed);
    this.host = {
      fetch: (input, init) => this.fetch(input, init),
      setTimeout: (callback, ms) => this.add(callback, delayOf(ms), undefined),
      clearTimeout: (timer) => this.clear(timer),
      setInterval: (callback, ms) => this.add(callback, Math.max(1, delayOf(ms)), Math.max(1, delayOf(ms))),
      clearInterval: (timer) => this.clear(timer),
      timeoutSignal: (ms) => {
        const controller = new AbortController();
        const timer = this.add(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), delayOf(ms), undefined);
        this.guards.set(controller.signal, timer as unknown as number);
        return controller.signal;
      },
      random: () => this.random(),
      uuid: () => uuidFrom(this.random),
    };
  }

  start(): void {
    this.started = true;
    let settled: Promise<unknown>;
    try {
      settled = Promise.resolve(this.main(this.host));
    } catch (error) {
      settled = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    settled.then(
      (value) => {
        this.result = { value: resultValue(value) };
      },
      (error: unknown) => {
        this.result = { error: errorText(error) };
      },
    );
  }

  /** An output of the code: compared with the log on replay, logged and sent when live. */
  private output(entry: LogEntry, send: (step: Step) => void): void {
    if (this.replay !== undefined) {
      const expected = this.replay.log[this.replay.at];
      if (expected === undefined || !deepEqual(expected, entry)) {
        this.divergence ??= `it tried to ${describeEntry(entry)}, ${expected === undefined ? 'past the end of its log' : `where the log has it ${describeEntry(expected)}`}`;
        return;
      }
      this.replay.at++;
      return;
    }
    if (this.step === undefined) {
      const error = new SystemError(
        `${this.id} called its host after its step was over: work left on the macrotask queue, a real timer above all, is not part of the model`,
      );
      this.onLate(error);
      throw error;
    }
    this.log = this.log.pushed(entry);
    send(this.step);
  }

  /** An input to the code, from the log on replay or logged first when live. */
  input(entry: LogEntry): void {
    if ('got' in entry || 'failed' in entry) {
      const [pending] = this.outstanding.splice(entry.pos, 1);
      if (pending === undefined) throw new SystemError(`${this.id} has no outstanding request ${entry.pos} to ${describeEntry(entry)}`);
      pending.cleanup?.();
      if ('got' in entry) pending.resolve(toResponse(entry.got));
      else pending.reject(new TypeError(entry.failed));
    } else if ('fired' in entry) {
      const timer = this.timers[entry.fired];
      if (timer === undefined) throw new SystemError(`${this.id} has no timer ${entry.fired} to fire`);
      this.timers.splice(entry.fired, 1);
      if (timer.interval !== undefined) this.insert({ ...timer, distance: timer.interval });
      timer.callback();
    } else if ('advanced' in entry) {
      for (const timer of this.timers) timer.distance = Math.max(0, timer.distance - entry.advanced);
    }
  }

  private fetch(input: string | URL | Request, init: RequestInit | undefined): Promise<Response> {
    try {
      const request = requestValue(input, init);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      // A fetch with an aborted signal rejects with its reason, whatever that is, and sends nothing.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      if (signal?.aborted) return Promise.reject(signal.reason);
      const pos = this.outstanding.length;
      this.output({ sent: request }, (step) => step.send(this.network, { fetch: request, pos } satisfies ToNetwork));
      return new Promise<Response>((resolve, reject) => {
        const pending: Pending = { resolve, reject };
        this.outstanding.push(pending);
        if (signal !== null && signal !== undefined) {
          const onAbort = () => this.abort(pending, signal.reason);
          signal.addEventListener('abort', onAbort, { once: true });
          pending.cleanup = () => {
            signal.removeEventListener('abort', onAbort);
            const guard = this.guards.get(signal);
            if (guard !== undefined) this.clearId(guard);
          };
        }
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private abort(pending: Pending, reason: unknown): void {
    const pos = this.outstanding.indexOf(pending);
    if (pos < 0) return;
    this.outstanding.splice(pos, 1);
    pending.cleanup?.();
    this.output({ aborted: pos }, (step) => step.send(this.network, { abort: pos } satisfies ToNetwork));
    pending.reject(reason);
  }

  /** A timer in its place: after every timer with a distance up to its own (the HTML rule). */
  private insert(timer: PendingTimer): void {
    let i = this.timers.length;
    while (i > 0 && this.timers[i - 1]!.distance > timer.distance) i--;
    this.timers.splice(i, 0, timer);
  }

  private add(callback: () => void, distance: number, interval: number | undefined): Timer {
    const id = this.nextTimer++;
    this.insert({ id, callback, distance, interval });
    return id as unknown as Timer;
  }

  private clear(timer: Timer): void {
    this.clearId(timer as unknown as number);
  }

  private clearId(id: number): void {
    const i = this.timers.findIndex((pending) => pending.id === id);
    if (i >= 0) this.timers.splice(i, 1);
  }

  snapshot(): ProgramValue {
    this.step = undefined;
    const timers = ValueList.from(
      this.timers.map((timer): TimerValue => (timer.interval === undefined ? { distance: timer.distance } : { distance: timer.distance, interval: timer.interval })),
    );
    return this.result === undefined ? { started: this.started, log: this.log, timers } : { started: this.started, log: this.log, timers, result: this.result };
  }
}

const runtimeOf = (runtime: ProgramRuntime): Runtime => runtime as unknown as Runtime;

function isToProgram(message: unknown): message is ToProgram {
  return typeof message === 'object' && message !== null && 'pos' in message && ('response' in message || 'error' in message);
}

/** How a program's value reads: what it is doing, and its timers. */
function describeProgram(value: ProgramValue): string {
  if (!value.started) return 'not started';
  const timers = value.timers.length === 0 ? '' : `, ${value.timers.length} timer${value.timers.length === 1 ? '' : 's'} pending`;
  if (value.result === undefined) return `running${timers}`;
  return `${'value' in value.result ? `returned ${_plain(value.result.value)}` : `threw ${value.result.error}`}${timers}`;
}

/**
 * Real code as a part: `main`, run against a host whose answers, timers
 * and failures the search explores. Its value is the log of what the host
 * delivered and took; `restore` replays it. `fetch` goes to the part
 * `options.network` names, `'net'` by default, which `http()` is.
 */
export function program(main: (host: Host) => unknown, options: ProgramOptions = {}): Kind<ProgramValue, ProgramRuntime, ProgramEvent> {
  const network = options.network ?? 'net';
  const seed = options.seed ?? 1;
  // A host call after a step was over. Thrown where it was made, and from
  // here at the part's next step.
  let late: SystemError | null = null;
  const onLate = (error: SystemError) => {
    late ??= error;
  };
  const fresh = (): void => {
    if (late !== null) throw late;
  };

  return {
    initial: () => ({ started: false, log: ValueList.empty(), timers: ValueList.empty() }),

    events(value) {
      if (!value.started) return [{ event: 'start', expected: true }];
      if (value.timers.length === 0) return [];
      if (value.timers.get(0).distance === 0) return [{ event: { fire: 0 }, expected: true }];
      const distances = new Set<number>();
      for (const timer of value.timers.toArray()) distances.add(timer.distance);
      return [...distances].map((distance) => ({ event: { advance: distance } }));
    },

    async restore(id, value) {
      fresh();
      const runtime = new Runtime(id, main, network, seed, onLate);
      if (!value.started) return runtime as unknown as ProgramRuntime;
      const log = value.log.toArray();
      runtime.replay = { log, at: 0 };
      runtime.start();
      await _drain();
      while (runtime.divergence === undefined && runtime.replay.at < log.length) {
        const entry = log[runtime.replay.at]!;
        if ('sent' in entry || 'aborted' in entry) {
          runtime.divergence = `it did not ${describeEntry(entry)}, as the log has it`;
          break;
        }
        runtime.replay.at++;
        runtime.input(entry);
        await _drain();
      }
      if (runtime.divergence !== undefined) throw new SystemError(`${id} diverged on replay: ${runtime.divergence}. The code is not a function of its inputs`);
      runtime.replay = undefined;
      runtime.log = value.log;
      const rebuilt = runtime.snapshot();
      if (!deepEqual(rebuilt, value)) {
        throw new SystemError(`${id} rebuilt from its value is ${describeProgram(rebuilt)}, where the value says ${describeProgram(value)}: state lived outside the value`);
      }
      return runtime as unknown as ProgramRuntime;
    },

    ingest(runtime, event, step) {
      fresh();
      const live = runtimeOf(runtime);
      live.step = step;
      if (event === 'start') {
        live.start();
        return;
      }
      const entry: LogEntry = 'fire' in event ? { fired: event.fire } : { advanced: event.advance };
      live.log = live.log.pushed(entry);
      live.input(entry);
    },

    receive(runtime, from, message, step) {
      fresh();
      if (!isToProgram(message)) throw new SystemError(`${runtimeOf(runtime).id} received something from ${from} that is not an answer or a failure: ${_plain(message)}`);
      const live = runtimeOf(runtime);
      live.step = step;
      const entry: LogEntry = 'response' in message ? { got: message.response, pos: message.pos } : { failed: message.error, pos: message.pos };
      live.log = live.log.pushed(entry);
      live.input(entry);
    },

    snapshot: (runtime) => runtimeOf(runtime).snapshot(),

    describeEvent: (event, _value, id) => (event === 'start' ? `${id} starts` : 'fire' in event ? `a timer of ${id} fires` : `${id} waits ${event.advance} ms`),
    describeValue: describeProgram,
  };
}
