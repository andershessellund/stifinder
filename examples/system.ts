// ---------------------------------------------------------------------------
// A prototype of the composable-systems proposal (DECISIONS.md), as far as a
// test of real code needs it: `system` composes parts into a `Model`;
// `program` runs real code behind a host whose value is the log of what the
// host delivered; `mock` is a server as a reducer; `http` is the network.
// Nothing here is library code yet; it is written to learn what the library
// should be.
//
// Parts talk by message. A part's `ingest` or `receive` sends to a peer by
// id through the step, and the system delivers after the sender's work is
// done and its microtasks have drained, restoring the receiver first. So no
// part ever holds another's runtime, a replay has no step to send through,
// and the system sees every message that crosses a boundary.
// ---------------------------------------------------------------------------
import type { Model } from 'stifinder';
import { deepEqual } from 'valsem';

/** What a part can do next: whether it expects it, and what it is charged. */
export interface Offer<Event> {
  event: Event;
  expected?: boolean;
  cost?: readonly string[];
}

/** A step in progress: how a part reaches a peer. */
export interface Step {
  send(to: string, message: unknown): void;
}

/** A kind of part: its value for the cache, its runtime for the code. */
export interface Kind<Value, Runtime, Event> {
  initial: Value;
  /** A function of the value alone: the system asks every part without restoring one. */
  events(value: Value): Offer<Event>[];
  /** A runtime for the value: the live one if its value matches, else one rebuilt. */
  restore(value: Value): Runtime | Promise<Runtime>;
  ingest(runtime: Runtime, event: Event, step: Step): void;
  receive(runtime: Runtime, from: string, message: unknown, step: Step): void;
  snapshot(runtime: Runtime): Value;
  describeEvent(event: Event, value: Value): string;
  describe(value: Value): string;
}

// The drain that ends a step: a yield to the macrotask queue, with the real
// timer as it was when this module loaded.
const defer = globalThis.setImmediate;
const drain = (): Promise<void> => new Promise((resolve) => defer(resolve));

/** A request or an answer as a value, which is how it crosses a boundary. */
export interface RequestValue {
  method: string;
  url: string;
}
export interface ResponseValue {
  status: number;
  body?: string;
}

// --- system ---------------------------------------------------------------

export type Product = Record<string, unknown>;
export interface ProductEvent {
  part: string;
  event: unknown;
}
type AnyKind = Kind<unknown, unknown, unknown>;

/**
 * The parts as one model. A state is every part's value by id; an event is
 * one part's event; a step restores the owner, runs its `ingest`, drains,
 * then delivers what was sent, each into a restored receiver and each
 * followed by a drain, until nothing is left; the parts restored are the
 * ones snapshotted. The events of a state are the candidates first — what
 * the parts expect, in part order, or where nothing is expected each part's
 * first event — then the rest. `ends` is what must hold wherever the
 * system stops; a throw is the violation.
 */
export function system<Kinds extends Record<string, AnyKind>>(
  kinds: Kinds,
  ends?: (state: NoInfer<{ [Id in keyof Kinds]: Kinds[Id]['initial'] }>) => void,
): Model<Product, ProductEvent> {
  const ids = Object.keys(kinds);
  const kind = (id: string): AnyKind => {
    const found = kinds[id];
    if (found === undefined) throw new Error(`stifinder: no part is called ${JSON.stringify(id)}`);
    return found;
  };
  return {
    initialState: Object.fromEntries(ids.map((id) => [id, kind(id).initial])),
    getEvents(state) {
      const offers = ids.flatMap((part) => kind(part).events(state[part]).map((offer) => ({ part, ...offer })));
      const expected = offers.filter((offer) => offer.expected);
      const candidates = expected.length > 0 ? expected : ids.flatMap((id) => offers.find((offer) => offer.part === id) ?? []);
      const rest = offers.filter((offer) => !candidates.includes(offer));
      return [...candidates, ...rest].map(({ part, event, cost }) => ({ event: { part, event }, ...(cost ? { cost } : {}) }));
    },
    async applyEvent(state, { part, event }) {
      const runtimes = new Map<string, unknown>();
      const restored = async (id: string): Promise<unknown> => {
        if (!runtimes.has(id)) runtimes.set(id, await kind(id).restore(state[id]));
        return runtimes.get(id);
      };
      const mail: { from: string; to: string; message: unknown }[] = [];
      const stepFor = (from: string): Step => ({ send: (to, message) => void mail.push({ from, to, message }) });

      kind(part).ingest(await restored(part), event, stepFor(part));
      await drain();
      for (let next = mail.shift(); next !== undefined; next = mail.shift()) {
        kind(next.to).receive(await restored(next.to), next.from, next.message, stepFor(next.to));
        await drain();
      }
      const to = { ...state };
      for (const [id, runtime] of runtimes) to[id] = kind(id).snapshot(runtime);
      return { to };
    },
    terminalInvariant(state) {
      ends?.(state as { [Id in keyof Kinds]: Kinds[Id]['initial'] });
      return undefined;
    },
    describeEvent: ({ part, event }, state) => kind(part).describeEvent(event, state[part]),
    describeState: (state) => ids.map((id) => `${id}: ${kind(id).describe(state[id])}`).join('; '),
  };
}

/** A kind whose runtime is its value, in a cell for the length of a step. */
export interface Cell<Value> {
  value: Value;
}
type ValueKind<Value, Event> = Omit<Kind<Value, Cell<Value>, Event>, 'restore' | 'snapshot'>;
const valueKind = <Value, Event>(kind: ValueKind<Value, Event>): Kind<Value, Cell<Value>, Event> => ({
  ...kind,
  restore: (value) => ({ value }),
  snapshot: (cell) => cell.value,
});

// --- program --------------------------------------------------------------

/** What the code under test takes its platform from. */
export interface Host {
  fetch: typeof globalThis.fetch;
}

/** One thing the host delivered or took, in order. */
export type Entry = { sent: RequestValue } | { got: ResponseValue; pos: number } | { failed: string; pos: number };
export type Settled = { value: unknown } | { error: string };

export interface ProgramValue {
  started: boolean;
  /** The inputs the host delivered and the outputs it took, in order. */
  log: Entry[];
  /** What `main` settled with, once it has. */
  result?: Settled;
}

type ToClient = { pos: number; response: ResponseValue } | { pos: number; error: string };

/** What `main` resolved with, as a value: a `Response` by its status. */
const settledValue = (value: unknown): unknown => (value instanceof Response ? { status: value.status } : value);
const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Real code behind a host. Its value is the log of inputs the host delivered
 * and outputs it took. `restore` resumes the live runtime when its value
 * matches, else runs `main` again with the log replayed: inputs fed back,
 * outputs suppressed and compared with the log, a difference being the
 * test's error. Its one event is to start; everything after is a delivery.
 */
interface Pending {
  resolve(response: Response): void;
  reject(error: unknown): void;
}
const diverged = (what: string) => new Error(`stifinder: the program diverged on replay: ${what}`);

/** The live side of a program part: `main` running against the host. */
export class ProgramRuntime {
  started = false;
  log: Entry[] = [];
  result: Settled | undefined;
  /** The requests the code is waiting on, in the order it made them. */
  outstanding: Pending[] = [];
  /** The step this runtime is live in, or undefined while it is replaying. */
  step: Step | undefined;
  /** What is left to replay, or undefined when live. */
  replay: Entry[] | undefined;
  /** How the code departed from the log on replay. Recorded, not thrown: a
   *  throw would go through the code under test, which may catch it. */
  divergence: string | undefined;

  readonly main: (host: Host) => Promise<unknown>;
  readonly network: string;

  constructor(main: (host: Host) => Promise<unknown>, network: string) {
    this.main = main;
    this.network = network;
  }

  host: Host = {
    fetch: (input, init) => {
      const request: RequestValue = {
        method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
        url: input instanceof Request ? input.url : String(input),
      };
      if (this.replay !== undefined) {
        const next = this.replay.shift();
        if (next === undefined || !('sent' in next) || !deepEqual(next.sent, request)) {
          this.divergence ??= `${request.method} ${request.url} was not what the log has next`;
          return new Promise<Response>(() => undefined); // the code waits; restore reports
        }
      } else {
        if (this.step === undefined) throw new Error('stifinder: fetch called outside a step');
        this.log.push({ sent: request });
        this.step.send(this.network, { fetch: request, pos: this.outstanding.length });
      }
      return new Promise<Response>((resolve, reject) => this.outstanding.push({ resolve, reject }));
    },
  };

  start(): void {
    this.started = true;
    this.main(this.host).then(
      (value) => void (this.result = { value: settledValue(value) }),
      (error: unknown) => void (this.result = { error: errorText(error) }),
    );
  }

  settle(entry: Entry): void {
    if ('sent' in entry) return;
    const [pending] = this.outstanding.splice(entry.pos, 1);
    if (pending === undefined) throw diverged(`nothing is outstanding at ${entry.pos}`);
    if ('got' in entry) pending.resolve(new Response(entry.got.body ?? null, { status: entry.got.status }));
    else pending.reject(new TypeError(entry.failed));
  }
}

export function program(main: (host: Host) => Promise<unknown>, { network = 'net' } = {}): Kind<ProgramValue, ProgramRuntime, 'start'> {
  let live: { runtime: ProgramRuntime; value: ProgramValue } | undefined;

  return {
    initial: { started: false, log: [] },
    events: (value) => (value.started ? [] : [{ event: 'start', expected: true }]),
    async restore(value) {
      if (live !== undefined && deepEqual(live.value, value)) return live.runtime;
      const runtime = new ProgramRuntime(main, network);
      if (!value.started) return runtime;
      runtime.replay = [...value.log];
      runtime.start();
      await drain();
      while (runtime.divergence === undefined && runtime.replay.length > 0) {
        const next = runtime.replay[0]!;
        if ('sent' in next) throw diverged(`the code did not send ${next.sent.method} ${next.sent.url}`);
        runtime.replay.shift();
        runtime.settle(next);
        await drain();
      }
      if (runtime.divergence !== undefined) throw diverged(runtime.divergence);
      runtime.replay = undefined;
      runtime.log = [...value.log];
      if (!deepEqual(runtime.result, value.result)) throw diverged('it settled differently');
      return runtime;
    },
    ingest(runtime, _event, step) {
      runtime.step = step;
      runtime.start();
    },
    receive(runtime, _from, message, step) {
      runtime.step = step;
      const { pos } = message as ToClient;
      const entry: Entry = 'response' in (message as ToClient) ? { got: (message as { response: ResponseValue }).response, pos } : { failed: (message as { error: string }).error, pos };
      runtime.log.push(entry);
      runtime.settle(entry);
    },
    snapshot(runtime) {
      runtime.step = undefined;
      const value: ProgramValue = { started: runtime.started, log: [...runtime.log], ...(runtime.result ? { result: runtime.result } : {}) };
      live = { runtime, value };
      return value;
    },
    describeEvent: () => 'the client starts',
    describe: (value) =>
      !value.started ? 'not started' : value.result === undefined ? 'running' : 'value' in value.result ? `returned ${JSON.stringify(value.result.value)}` : `threw ${value.result.error}`,
  };
}

// --- mock -----------------------------------------------------------------

/** One way a mock may answer: the state it leaves, the answer, and what it is charged. */
export interface Outcome<State> {
  state: State;
  response: ResponseValue;
  label?: string;
  cost?: readonly string[];
}

export interface MockValue<State> {
  state: State;
  /** The requests delivered and not yet answered, with who to answer. */
  pending: { request: RequestValue; from: string }[];
}

/**
 * A server as a reducer. `handle` returns the outcome of the oldest
 * pending request, or several, the first expected; the alternatives are the
 * mock's own events. A mock with nothing pending has no events.
 */
export function mock<State>(
  initial: State,
  handle: (state: State, request: RequestValue) => Outcome<State> | Outcome<State>[],
): Kind<MockValue<State>, Cell<MockValue<State>>, number> {
  const outcomes = (value: MockValue<State>): Outcome<State>[] => {
    const head = value.pending[0];
    if (head === undefined) return [];
    const result = handle(value.state, head.request);
    return Array.isArray(result) ? result : [result];
  };
  const label = (outcome: Outcome<State>) => outcome.label ?? `answers ${outcome.response.status}`;
  return valueKind<MockValue<State>, number>({
    initial: { state: initial, pending: [] },
    events: (value) => outcomes(value).map((outcome, k) => ({ event: k, expected: k === 0, ...(outcome.cost ? { cost: outcome.cost } : {}) })),
    ingest(cell, k, step) {
      const outcome = outcomes(cell.value)[k]!;
      const [head, ...pending] = cell.value.pending;
      cell.value = { state: outcome.state, pending };
      step.send(head!.from, { respond: outcome.response });
    },
    receive(cell, from, message) {
      const { request } = message as { request: RequestValue };
      cell.value = { ...cell.value, pending: [...cell.value.pending, { request, from }] };
    },
    describeEvent: (k, value) => `the server ${label(outcomes(value)[k]!)}`,
    describe: (value) => `${JSON.stringify(value.state)}, ${value.pending.length} pending`,
  });
}

// --- http -----------------------------------------------------------------

/** A message in flight. A request is named by its client's position for it. */
export type Leg =
  | { kind: 'request'; client: string; pos: number; server: string; request: RequestValue }
  | { kind: 'response'; client: string; pos: number; response: ResponseValue };

export interface HttpValue {
  /** Oldest first. */
  inFlight: Leg[];
  /** Per server, the requests in progress there, in delivery order. */
  inProgress: Record<string, { client: string; pos: number }[]>;
}
export type HttpEvent = { deliver: number } | { fail: number };

/** `value` with every position of `client` above `pos` moved down by one. */
function shifted(value: HttpValue, client: string, pos: number): HttpValue {
  const down = <T extends { client: string; pos: number }>(entry: T): T =>
    entry.client === client && entry.pos > pos ? { ...entry, pos: entry.pos - 1 } : entry;
  return {
    inFlight: value.inFlight.map(down),
    inProgress: Object.fromEntries(Object.entries(value.inProgress).map(([id, list]) => [id, list.map(down)])),
  };
}

/**
 * The network: every message in flight, oldest first, and the requests in
 * progress at each server. `routes` says which server a URL names. It
 * expects to deliver the oldest message; any other delivery is a
 * reordering, and a connection may fail, which the client sees as a
 * rejected fetch: before delivery the server never saw the request, after
 * it the server answered and nobody heard.
 */
export function http(routes: Record<string, string>): Kind<HttpValue, Cell<HttpValue>, HttpEvent> {
  const serverFor = (url: string): string => {
    const route = Object.entries(routes).find(([base]) => url.startsWith(base));
    if (route === undefined) throw new Error(`stifinder: no route for ${url}`);
    return route[1];
  };
  const what = (leg: Leg) => (leg.kind === 'request' ? 'the request' : `the ${leg.response.status} answer`);
  return valueKind<HttpValue, HttpEvent>({
    initial: { inFlight: [], inProgress: {} },
    events: (value) => [
      ...value.inFlight.map((_, i) => ({ event: { deliver: i }, expected: i === 0 })),
      ...value.inFlight.map((_, i) => ({ event: { fail: i }, cost: ['network-error'] })),
    ],
    ingest(cell, event, step) {
      const value = cell.value;
      const i = 'deliver' in event ? event.deliver : event.fail;
      const leg = value.inFlight[i]!;
      const inFlight = value.inFlight.filter((_, k) => k !== i);
      if ('fail' in event) {
        cell.value = shifted({ ...value, inFlight }, leg.client, leg.pos);
        step.send(leg.client, { pos: leg.pos, error: leg.kind === 'request' ? 'connection refused' : 'connection reset' });
      } else if (leg.kind === 'request') {
        const list = [...(value.inProgress[leg.server] ?? []), { client: leg.client, pos: leg.pos }];
        cell.value = { inFlight, inProgress: { ...value.inProgress, [leg.server]: list } };
        step.send(leg.server, { request: leg.request });
      } else {
        cell.value = shifted({ ...value, inFlight }, leg.client, leg.pos);
        step.send(leg.client, { pos: leg.pos, response: leg.response });
      }
    },
    receive(cell, from, message) {
      const value = cell.value;
      if ('fetch' in (message as object)) {
        const { fetch: request, pos } = message as { fetch: RequestValue; pos: number };
        const leg: Leg = { kind: 'request', client: from, pos, server: serverFor(request.url), request };
        cell.value = { ...value, inFlight: [...value.inFlight, leg] };
      } else {
        const { respond: response } = message as { respond: ResponseValue };
        const [head, ...rest] = value.inProgress[from] ?? [];
        if (head === undefined) throw new Error(`stifinder: ${from} answered with nothing in progress`);
        const leg: Leg = { kind: 'response', client: head.client, pos: head.pos, response };
        cell.value = { inFlight: [...value.inFlight, leg], inProgress: { ...value.inProgress, [from]: rest } };
      }
    },
    describeEvent: (event, value) =>
      'deliver' in event
        ? `${what(value.inFlight[event.deliver]!)} is delivered`
        : `the connection fails, and ${what(value.inFlight[event.fail]!)} never arrives`,
    describe: (value) => `${value.inFlight.length === 0 ? 'nothing' : value.inFlight.map(what).join(', ')} in flight`,
  });
}
