// ---------------------------------------------------------------------------
// A program part: real code behind a host, as a part of a system.
//
// The code is `main(host)`, run for real; the host is the simulated
// platform it takes `fetch`, its timers and its randomness from. The part's
// value is the log of what the host delivered and took, in order — the
// answers and failures of its requests, its timers firing, the requests it
// sent and aborted — with its pending timers as distances to fire, and what
// `main` settled with once it has. Its runtime is the code, running:
// `restore` runs `main` again with the log replayed, inputs fed back and
// outputs compared with the log, and the system resumes the live runtime
// where the value matches.
//
// Time is local and relative: a timer is a distance to fire, an advance
// subtracts, and the clock is never read. The part expects to fire the
// head of its due queue; its other events are advances to its pending
// timers' distances, never expected, since time proceeds only when nothing
// else can happen — and offered while a timer is due too, since a
// callback may run late. The log records which timer fired and never an
// advance, so histories that differ only in how time moved are one state:
// a timer is named by an id of its own, and a restore sets the distances
// from the value. A `timeoutSignal`'s timer is unreferenced, as the
// platform's is: nothing waits for it, so time moves to it only while the
// part has a request in flight or a timer due, but it counts down, and
// fires when time reaches it. Randomness is a seeded stream, seeded by the part's id
// too, so a replay draws the same numbers and no draw is logged.
//
// A difference on replay, a request that is not a value, and a host call
// after the step is over — from a real timer above all — are the test's
// errors. None is thrown into the code, which may catch it: each is
// recorded by the host and raised by the system, a difference by
// `restore` once the drain is over, the others at the next step. The code
// that made such a call waits on a promise that never settles.
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

/** One thing the host delivered (an input) or took (an output), in order.
 *  `fired` names the timer by its id. */
export type LogEntry = { sent: RequestValue } | { aborted: number } | { got: ResponseValue; pos: number } | { failed: string; pos: number } | { fired: number };

/** A pending timer: its id, how far it is from firing, its period if it
 *  repeats, and whether it is unreferenced, as a timeout signal's is:
 *  time moves to it only while a request is in flight or a timer is due. */
export interface TimerValue {
  id: number;
  distance: number;
  interval?: number | undefined;
  unref?: true | undefined;
}

/** What `main` settled with: its value, a `Response` by its status, or its error's message. */
export type Settled = { value: unknown } | { error: string };

export interface ProgramValue {
  started: boolean;
  log: ValueList<LogEntry>;
  /** Pending timers in the order they fire: by when they are due, and at equal dues in the order they were set or re-armed. */
  timers: ValueList<TimerValue>;
  result?: Settled | undefined;
}

/** Start; fire the due timer with that id; move the clock by `advance`. */
export type ProgramEvent = 'start' | { fire: number } | { advance: number };

export interface ProgramOptions {
  /** The id of the network part `fetch` sends to. Default: `'net'`. */
  network?: string | undefined;
  /** The seed of the host's random stream, mixed with the part's id. Default: 1. */
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
  return `fire timer ${entry.fired}`;
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

/** A `Response` from the value; one no `Response` can be is the server part's error. */
function toResponse(value: ResponseValue): Response {
  try {
    return new Response(value.body ?? null, { status: value.status, headers: value.headers });
  } catch (error) {
    throw new SystemError(`an answer with status ${value.status}${value.body === undefined ? '' : ' and a body'} is not one a Response can be: ${errorText(error)}`);
  }
}

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

/** The seed and the part's id as one seed (FNV-1a over the id), so that two parts draw differently. */
function seedFor(seed: number, id: string): number {
  let h = 0x811c9dc5 ^ (seed | 0);
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return h | 0;
}

/** A version-4 UUID from the stream. */
function uuidFrom(random: () => number): string {
  const hex = Array.from({ length: 8 }, () => Math.floor(random() * 0x10000).toString(16).padStart(4, '0')).join('');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A delay as the host keeps it: whole milliseconds, none below zero. */
const delayOf = (ms: number): number => (Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0);

/** A promise for code that has left the model: it never settles, so nothing more happens. */
const never = (): Promise<never> => new Promise(() => undefined);

interface Pending {
  resolve(response: Response): void;
  reject(error: unknown): void;
  /** Once settled: stops listening for an abort. */
  cleanup?: () => void;
}

interface PendingTimer {
  id: number;
  callback: () => void;
  distance: number;
  interval: number | undefined;
  unref: boolean;
}

/** The code, running, and the host it runs against. */
class Runtime {
  started = false;
  log = ValueList.empty<LogEntry>();
  /** Pending timers, by when they are due, and at equal dues in the order they were set or re-armed. */
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
  /** A host call the model cannot take, recorded, not thrown: raised when the step is snapshotted. */
  fault: SystemError | undefined;
  readonly host: Host;
  private nextTimer = 1;
  /** The timer whose callback is running, until the callback clears it. */
  private firing: PendingTimer | undefined;
  private readonly random: () => number;

  constructor(
    readonly id: string,
    private readonly main: (host: Host) => unknown,
    private readonly network: string,
    seed: number,
    private readonly onLate: (error: SystemError) => void,
  ) {
    this.random = mulberry32(seedFor(seed, id));
    this.host = {
      fetch: (input, init) => this.fetch(input, init),
      setTimeout: (callback, ms) => this.add(callback, delayOf(ms), undefined, false),
      clearTimeout: (timer) => this.clear(timer),
      setInterval: (callback, ms) => this.add(callback, Math.max(1, delayOf(ms)), Math.max(1, delayOf(ms)), false),
      clearInterval: (timer) => this.clear(timer),
      timeoutSignal: (ms) => {
        const controller = new AbortController();
        this.add(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), delayOf(ms), undefined, true);
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

  /**
   * An output of the code: compared with the log on replay, logged and
   * sent when live. False when the code has left the model — a call after
   * its step was over — which is recorded for the system and not thrown
   * into the code, nor out of whatever called it.
   */
  private output(entry: LogEntry, send: (step: Step) => void): boolean {
    if (this.replay !== undefined) {
      const expected = this.replay.log[this.replay.at];
      if (expected === undefined || !deepEqual(expected, entry)) {
        this.divergence ??= `it tried to ${describeEntry(entry)}, ${expected === undefined ? 'past the end of its log' : `where the log has it ${describeEntry(expected)}`}`;
        return false;
      }
      this.replay.at++;
      return true;
    }
    if (this.step === undefined) {
      this.onLate(
        new SystemError(
          `${this.id} called its host after its step was over: work left on the macrotask queue, a real timer above all, is not part of the model`,
        ),
      );
      return false;
    }
    this.log = this.log.pushed(entry);
    send(this.step);
    return true;
  }

  /** An input to the code, from the log on replay or logged first when live. */
  input(entry: LogEntry): void {
    if ('got' in entry || 'failed' in entry) {
      const pending = this.outstanding[entry.pos];
      if (pending === undefined) throw new SystemError(`${this.id} has no outstanding request ${entry.pos} to ${describeEntry(entry)}`);
      const response = 'got' in entry ? toResponse(entry.got) : undefined;
      this.outstanding.splice(entry.pos, 1);
      pending.cleanup?.();
      if (response !== undefined) pending.resolve(response);
      else if ('failed' in entry) pending.reject(new TypeError(entry.failed));
    } else if ('fired' in entry) {
      const i = this.timers.findIndex((timer) => timer.id === entry.fired);
      const timer = this.timers[i];
      if (timer === undefined) throw new SystemError(`${this.id} has no timer ${entry.fired} to fire`);
      this.timers.splice(i, 1);
      // An interval comes back at its period once its callback has run,
      // unless the callback cleared it, as the platform re-arms one: a
      // timer the callback sets for the same period fires first.
      this.firing = timer;
      try {
        timer.callback();
      } finally {
        if (timer.interval !== undefined && this.firing === timer) this.insert({ ...timer, distance: timer.interval });
        this.firing = undefined;
      }
    }
  }

  /** The clock moves: every pending timer is that much nearer, and the due ones are at zero. */
  advance(by: number): void {
    for (const timer of this.timers) timer.distance = Math.max(0, timer.distance - by);
  }

  private fetch(input: string | URL | Request, init: RequestInit | undefined): Promise<Response> {
    let request: RequestValue;
    try {
      request = requestValue(input, init);
    } catch (error) {
      // Not a value: the model cannot take it. Recorded for the system; the
      // code waits, as it would have for an answer.
      if (error instanceof SystemError) {
        this.fault ??= error;
        return never();
      }
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    if ((request.method === 'GET' || request.method === 'HEAD') && request.body !== undefined) {
      return Promise.reject(new TypeError(`Request with ${request.method}/HEAD method cannot have body`));
    }
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    // A fetch with an aborted signal rejects with its reason, whatever that is, and sends nothing.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    if (signal?.aborted) return Promise.reject(signal.reason);
    const pos = this.outstanding.length;
    if (!this.output({ sent: request }, (step) => step.send(this.network, { fetch: request, pos } satisfies ToNetwork))) return never();
    return new Promise<Response>((resolve, reject) => {
      const pending: Pending = { resolve, reject };
      this.outstanding.push(pending);
      if (signal !== null && signal !== undefined) {
        const onAbort = () => this.abort(pending, signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        pending.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
    });
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

  private add(callback: () => void, distance: number, interval: number | undefined, unref: boolean): Timer {
    const id = this.nextTimer++;
    this.insert({ id, callback, distance, interval, unref });
    return id as unknown as Timer;
  }

  private clear(timer: Timer): void {
    this.clearId(timer as unknown as number);
  }

  private clearId(id: number): void {
    if (this.firing?.id === id) this.firing = undefined;
    const i = this.timers.findIndex((pending) => pending.id === id);
    if (i >= 0) this.timers.splice(i, 1);
  }

  /** The timers as the value has them: the same ones, by id, at the value's distances, in order. */
  reconcile(timers: readonly TimerValue[]): string | undefined {
    const live = new Map(this.timers.map((timer) => [timer.id, timer]));
    const next: PendingTimer[] = [];
    for (const timer of timers) {
      const pending = live.get(timer.id);
      if (pending === undefined) return `it did not set timer ${timer.id}, which the value has`;
      if (pending.interval !== timer.interval) return `it set timer ${timer.id} with another period than the value has`;
      if (pending.unref !== (timer.unref === true)) return `it set timer ${timer.id} ${pending.unref ? 'for a timeout signal' : 'as a timer'}, where the value has it ${pending.unref ? 'as a timer' : 'for a timeout signal'}`;
      live.delete(timer.id);
      next.push({ ...pending, distance: timer.distance });
    }
    for (const timer of live.values()) return `it set timer ${timer.id}, which the value does not have`;
    // In the value's order, which is due order: the order the timers were
    // set in is not, after an advance past several or an interval re-armed.
    this.timers = next;
    return undefined;
  }

  snapshot(): ProgramValue {
    this.step = undefined;
    if (this.fault !== undefined) throw this.fault;
    const timers = ValueList.from(
      this.timers.map((timer): TimerValue => {
        const value: TimerValue = { id: timer.id, distance: timer.distance };
        if (timer.interval !== undefined) value.interval = timer.interval;
        if (timer.unref) value.unref = true;
        return value;
      }),
    );
    return this.result === undefined ? { started: this.started, log: this.log, timers } : { started: this.started, log: this.log, timers, result: this.result };
  }
}

const runtimeOf = (runtime: ProgramRuntime): Runtime => runtime as unknown as Runtime;

function isToProgram(message: unknown): message is ToProgram {
  return typeof message === 'object' && message !== null && 'pos' in message && ('response' in message || 'error' in message);
}

/** How many requests of the log are unsettled: sent, and neither answered, failed nor aborted. */
function inFlight(log: ValueList<LogEntry>): number {
  let count = 0;
  for (const entry of log.toArray()) {
    if ('sent' in entry) count++;
    else if (!('fired' in entry)) count--;
  }
  return count;
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
  // A host call after a step was over, recorded where it was made and
  // raised by the system at its next step, through `fault`.
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
      const timers = value.timers.toArray();
      // A due timer is expected to fire; time moving first is its callback running late.
      const due = timers[0]?.distance === 0;
      // Time moves to an unreferenced timer only while something else holds
      // the part: a timer due, or a request in flight, which may take that long.
      const waiting = due || inFlight(value.log) > 0;
      const distances = new Set<number>();
      for (const timer of timers) if (timer.distance > 0 && (waiting || !timer.unref)) distances.add(timer.distance);
      const advances = [...distances].map((distance) => ({ event: { advance: distance } }));
      return due ? [{ event: { fire: timers[0]!.id }, expected: true }, ...advances] : advances;
    },

    async restore(id, value) {
      fresh();
      const runtime = new Runtime(id, main, network, seed, onLate);
      if (!value.started) return runtime as unknown as ProgramRuntime;
      const log = value.log.toArray();
      runtime.replay = { log, at: 0 };
      runtime.start();
      await _drain();
      while (runtime.divergence === undefined && runtime.fault === undefined && runtime.replay.at < log.length) {
        const entry = log[runtime.replay.at]!;
        if ('sent' in entry || 'aborted' in entry) {
          runtime.divergence = `it did not ${describeEntry(entry)}, as the log has it`;
          break;
        }
        runtime.replay.at++;
        runtime.input(entry);
        await _drain();
      }
      if (runtime.fault !== undefined) throw runtime.fault;
      runtime.divergence ??= runtime.reconcile(value.timers.toArray());
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
      } else if ('fire' in event) {
        const entry: LogEntry = { fired: event.fire };
        live.log = live.log.pushed(entry);
        live.input(entry);
      } else {
        live.advance(event.advance);
      }
    },

    receive(runtime, from, message, step) {
      fresh();
      if (!isToProgram(message)) throw new SystemError(`${runtimeOf(runtime).id} received something from ${from} that is not an answer or a failure: ${_plain(message)}`);
      const live = runtimeOf(runtime);
      live.step = step;
      const entry: LogEntry = 'response' in message ? { got: message.response, pos: message.pos } : { failed: message.error, pos: message.pos };
      live.input(entry);
      live.log = live.log.pushed(entry);
    },

    snapshot: (runtime) => runtimeOf(runtime).snapshot(),

    fault: () => late ?? undefined,

    describeEvent: (event, _value, id) => (event === 'start' ? `${id} starts` : 'fire' in event ? `a timer of ${id} fires` : `${id} waits ${event.advance} ms`),
    describeValue: describeProgram,
  };
}
