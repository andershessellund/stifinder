// ---------------------------------------------------------------------------
// The generic parts: `http`, the network between clients and servers, and
// `mock`, a server as a reducer. A Cloudflare simulator brings its own
// parts; these are the ones every system over HTTP needs.
//
// The network owns every message in flight, oldest first, and the
// correlation between the endpoints' outstanding requests: a request is
// named by its position among its client's outstanding requests, never by
// an id, and the network keeps per client that list in send order and per
// server the requests in progress there in delivery order, shifting the
// positions above one that settles in the step that settles it. It expects
// to deliver the oldest message; any other delivery is a reordering, and
// its faults are a lost message, which is silence, and a failed
// connection, which the client sees at once as a rejected fetch.
//
// Why: DECISIONS.md D43, D44.
// ---------------------------------------------------------------------------

import type { RequestValue, ResponseValue, ToNetwork, ToProgram } from './program.js';
import { type Cell, type Kind, SystemError, _plain, valuePart } from './system.js';

/** The cost key of a lost message. */
export const LOSS = 'loss';
/** The cost key of a failed connection. */
export const FAILURE = 'failure';

// --- mock -----------------------------------------------------------------

/** One way a mock may answer: the state it leaves, the answer, and what it is charged. */
export interface Outcome<State> {
  state: State;
  response: ResponseValue;
  /** How answering so reads in a report. Default: `answers <status>`. */
  label?: string | undefined;
  /** The cost keys it charges, one unit per occurrence. */
  cost?: readonly string[] | undefined;
}

export interface MockValue<State> {
  state: State;
  /** The requests delivered and not yet answered, in delivery order, with who to answer. */
  pending: readonly { request: RequestValue; from: string }[];
}

/** What the network delivers to a server. */
export type ToServer = { request: RequestValue };
/** What a server sends to the network: the answer to the oldest request in progress with it. */
export type ToNetworkFromServer = { respond: ResponseValue };

/** The outcomes of the oldest pending request: one, or several, the first expected. Must be pure. */
export type MockHandle<State> = (state: State, request: RequestValue) => Outcome<State> | readonly Outcome<State>[];

const isToServer = (message: unknown): message is ToServer => typeof message === 'object' && message !== null && 'request' in message;

/**
 * A server as a reducer: `handle(state, request)` says how the oldest
 * pending request is answered, in one way or several, the first expected
 * and the rest the mock's own events, each with a label and cost keys.
 * The state must be a value. A mock with nothing pending has no events.
 */
export function mock<State>(initial: State, handle: MockHandle<State>): Kind<MockValue<State>, Cell<MockValue<State>>, number> {
  const outcomes = (value: MockValue<State>): readonly Outcome<State>[] => {
    const head = value.pending[0];
    if (head === undefined) return [];
    const result = handle(value.state, head.request);
    const list = Array.isArray(result) ? (result as readonly Outcome<State>[]) : [result as Outcome<State>];
    if (list.length === 0) throw new SystemError(`a mock's handle returned no outcome for ${head.request.method} ${head.request.url}`);
    return list;
  };
  const label = (outcome: Outcome<State>): string => outcome.label ?? `answers ${outcome.response.status}`;

  return valuePart<MockValue<State>, number>({
    initial: () => ({ state: initial, pending: [] }),
    events: (value) => outcomes(value).map((outcome, k) => (outcome.cost === undefined ? { event: k, expected: k === 0 } : { event: k, expected: k === 0, cost: outcome.cost })),
    ingest(cell, k, step) {
      const outcome = outcomes(cell.value)[k];
      const [head, ...pending] = cell.value.pending;
      if (outcome === undefined || head === undefined) throw new SystemError(`a mock has no outcome ${k} to take`);
      cell.value = { state: outcome.state, pending };
      step.send(head.from, { respond: outcome.response } satisfies ToNetworkFromServer);
    },
    receive(cell, from, message) {
      if (!isToServer(message)) throw new SystemError(`a mock received something from ${from} that is not a request: ${_plain(message)}`);
      cell.value = { ...cell.value, pending: [...cell.value.pending, { request: message.request, from }] };
    },
    describeEvent: (k, value, id) => {
      const outcome = outcomes(value)[k];
      return outcome === undefined ? `${id} answers` : `${id} ${label(outcome)}`;
    },
    describeValue: (value) => `${_plain(value.state)}${value.pending.length === 0 ? '' : `, ${value.pending.length} pending`}`,
  });
}

// --- http -----------------------------------------------------------------

/** A message in flight: a request, by its client's position for it (null
 *  once the client gave up on it: an orphan), or an answer. */
export type Leg =
  | { kind: 'request'; client: string; pos: number | null; server: string; request: RequestValue }
  | { kind: 'response'; client: string; pos: number; response: ResponseValue };

/** A request in progress at a server: whose, and which; null for an orphan. */
export type Progress = { client: string; pos: number } | null;

export interface HttpValue {
  /** Oldest first. */
  inFlight: readonly Leg[];
  /** Per server, the requests in progress there, in delivery order. A server with none is absent. */
  inProgress: Readonly<Record<string, readonly Progress[]>>;
}

/** Deliver, lose, or fail the connection of, the message at that index of `inFlight`. */
export type HttpEvent = { deliver: number } | { lose: number } | { fail: number };

const isFetch = (message: unknown): message is Extract<ToNetwork, { fetch: RequestValue }> =>
  typeof message === 'object' && message !== null && 'fetch' in message && 'pos' in message;
const isAbort = (message: unknown): message is Extract<ToNetwork, { abort: number }> => typeof message === 'object' && message !== null && 'abort' in message;
const isRespond = (message: unknown): message is ToNetworkFromServer => typeof message === 'object' && message !== null && 'respond' in message;

/** `inProgress` with `server`'s list replaced; a server with none is absent. */
function withProgress(inProgress: HttpValue['inProgress'], server: string, list: readonly Progress[]): HttpValue['inProgress'] {
  const rest = Object.fromEntries(Object.entries(inProgress).filter(([id]) => id !== server));
  return list.length === 0 ? rest : { ...rest, [server]: list };
}

/** `value` with every position of `client` above `pos` moved down by one. */
function shifted(value: HttpValue, client: string, pos: number): HttpValue {
  const down = <T extends { client: string; pos: number | null }>(entry: T): T =>
    entry.client === client && entry.pos !== null && entry.pos > pos ? { ...entry, pos: entry.pos - 1 } : entry;
  return {
    inFlight: value.inFlight.map(down),
    inProgress: Object.fromEntries(Object.entries(value.inProgress).map(([server, list]) => [server, list.map((entry) => (entry === null ? null : down(entry)))])),
  };
}

/** `value` once `client` gave up on its request `pos`: what is left of it is an orphan. */
function aborted(value: HttpValue, client: string, pos: number): HttpValue {
  const mine = (leg: Leg) => leg.client === client && leg.pos === pos;
  return shifted(
    {
      inFlight: value.inFlight.flatMap((leg): Leg[] => (!mine(leg) ? [leg] : leg.kind === 'request' ? [{ ...leg, pos: null }] : [])),
      inProgress: Object.fromEntries(
        Object.entries(value.inProgress).map(([server, list]) => [server, list.map((entry) => (entry !== null && entry.client === client && entry.pos === pos ? null : entry))]),
      ),
    },
    client,
    pos,
  );
}

/**
 * The network: every message in flight, oldest first, and the requests in
 * progress at each server. `routes` says which server a URL names, by
 * prefix. It expects to deliver the oldest message; its other events are
 * the other deliveries, a lost message (`loss`), and a failed connection
 * (`failure`), which the client sees at once as a rejected fetch: before
 * delivery the server never saw the request, after it the server answered
 * and nobody heard.
 */
export function http(routes: Readonly<Record<string, string>>): Kind<HttpValue, Cell<HttpValue>, HttpEvent> {
  const serverFor = (url: string): string => {
    for (const [base, server] of Object.entries(routes)) if (url.startsWith(base)) return server;
    throw new SystemError(`http has no route for ${url}; its routes are ${Object.keys(routes).map((base) => JSON.stringify(base)).join(', ') || 'none'}`);
  };
  const what = (leg: Leg): string => {
    if (leg.kind === 'response') return `the ${leg.response.status} answer to ${leg.client}`;
    if (leg.pos === null) return `the request ${leg.client} gave up on`;
    return `${leg.client}'s request${leg.pos === 0 ? '' : ` ${leg.pos}`}`;
  };

  return valuePart<HttpValue, HttpEvent>({
    initial: () => ({ inFlight: [], inProgress: {} }),

    events: (value) => [
      ...value.inFlight.map((_, i) => ({ event: { deliver: i }, expected: i === 0 })),
      ...value.inFlight.map((_, i) => ({ event: { lose: i }, cost: [LOSS] })),
      // A failed connection is told to the client; an orphan has none to tell, and losing it is the same.
      ...value.inFlight.flatMap((leg, i) => (leg.kind === 'request' && leg.pos === null ? [] : [{ event: { fail: i }, cost: [FAILURE] }])),
    ],

    ingest(cell, event, step) {
      const value = cell.value;
      const i = 'deliver' in event ? event.deliver : 'lose' in event ? event.lose : event.fail;
      const leg = value.inFlight[i];
      if (leg === undefined) throw new SystemError(`http has no message ${i} in flight`);
      const inFlight = value.inFlight.filter((_, k) => k !== i);
      if ('lose' in event) {
        cell.value = { ...value, inFlight };
      } else if ('fail' in event) {
        if (leg.pos === null) throw new SystemError('http cannot fail the connection of an orphan: nobody would hear');
        cell.value = shifted({ ...value, inFlight }, leg.client, leg.pos);
        const error = leg.kind === 'request' ? `fetch failed: the connection for ${leg.request.method} ${leg.request.url} was refused` : `fetch failed: the connection was reset before the ${leg.response.status} answer arrived`;
        step.send(leg.client, { pos: leg.pos, error } satisfies ToProgram);
      } else if (leg.kind === 'request') {
        const entry: Progress = leg.pos === null ? null : { client: leg.client, pos: leg.pos };
        cell.value = { inFlight, inProgress: withProgress(value.inProgress, leg.server, [...(value.inProgress[leg.server] ?? []), entry]) };
        step.send(leg.server, { request: leg.request } satisfies ToServer);
      } else {
        cell.value = shifted({ ...value, inFlight }, leg.client, leg.pos);
        step.send(leg.client, { pos: leg.pos, response: leg.response } satisfies ToProgram);
      }
    },

    receive(cell, from, message) {
      const value = cell.value;
      if (isFetch(message)) {
        const leg: Leg = { kind: 'request', client: from, pos: message.pos, server: serverFor(message.fetch.url), request: message.fetch };
        cell.value = { ...value, inFlight: [...value.inFlight, leg] };
      } else if (isAbort(message)) {
        cell.value = aborted(value, from, message.abort);
      } else if (isRespond(message)) {
        const [head, ...rest] = value.inProgress[from] ?? [];
        if (head === undefined) throw new SystemError(`${from} answered with no request in progress`);
        const inProgress = withProgress(value.inProgress, from, rest);
        // The answer to an orphan goes nowhere.
        cell.value =
          head === null ? { ...value, inProgress } : { inProgress, inFlight: [...value.inFlight, { kind: 'response', client: head.client, pos: head.pos, response: message.respond }] };
      } else {
        throw new SystemError(`http received something from ${from} it does not understand: ${_plain(message)}`);
      }
    },

    describeEvent: (event, value) => {
      const i = 'deliver' in event ? event.deliver : 'lose' in event ? event.lose : event.fail;
      const leg = value.inFlight[i];
      if (leg === undefined) return `http: ${_plain(event)}`;
      if ('deliver' in event) return `${what(leg)} is delivered`;
      if ('lose' in event) return `${what(leg)} is lost`;
      return `the connection fails, and ${what(leg)} never arrives`;
    },

    describeValue: (value) => {
      const flying = value.inFlight.length === 0 ? 'nothing in flight' : `in flight: ${value.inFlight.map(what).join(', ')}`;
      const progress = Object.entries(value.inProgress).map(([server, list]) => `${list.length} in progress at ${server}`);
      return [flying, ...progress].join('; ');
    },
  });
}
