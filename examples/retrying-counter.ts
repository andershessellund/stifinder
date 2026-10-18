// ---------------------------------------------------------------------------
// A client that retries until it succeeds, a server that counts, and the
// network between them: three parts, composed by hand.
//
// The client sends one request and waits. If the answer is an error, or it
// gives up waiting, it sends again; it stops at the first success. The
// server counts every request it answers with success. The network carries
// the messages, oldest first, and may lose one. Without a bound on faults
// the space is infinite: every lost answer is another count. Within a bound
// it is finite, and the search proves that wherever the client stops, the
// counter is at least one — and finds, at one fault, that it can be two.
//
// This is the composable-systems proposal of DECISIONS.md at its smallest.
// A part is defined by its initial value, the events its value allows, and
// what an event does; a part reaches a peer by id, through the step; the
// product's events are the parts' expected events first. The parts here are
// value parts, whose runtime is a cell holding the value. Nothing of this is
// library code yet.
//
//     pnpm build && node examples/retrying-counter.ts
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'node:url';
import { type Model, ViolationError, check } from 'stifinder';

// --- The part interface, as the proposal has it for value parts -----------

/** What a part can do next: whether it expects it, and what it is charged. */
interface Offer<Event> {
  event: Event;
  expected?: boolean;
  cost?: readonly string[];
}

/** A value part's runtime: a cell holding its value for the length of a step. */
interface Cell<Value> {
  value: Value;
}

/** A step in progress: how a part reaches a peer, by id. */
interface Step {
  part<Value>(id: string): Cell<Value>;
}

interface Part<Value, Event> {
  initial: Value;
  /** A function of the value alone: the product asks every part without running one. */
  events(value: Value): Offer<Event>[];
  ingest(self: Cell<Value>, event: Event, step: Step): void;
  describeEvent(event: Event, value: Value): string;
  describe(value: Value): string;
}

// --- The three parts ------------------------------------------------------

const CLIENT = 'client';
const SERVER = 'server';
const NET = 'net';

type Response = 'ok' | 'error';

/** The client: one request outstanding while it waits, at position 0. */
type ClientValue = { phase: 'idle' } | { phase: 'waiting' } | { phase: 'done' };
type ClientEvent = 'send' | 'give up';

const client: Part<ClientValue, ClientEvent> & {
  /** The network delivers the answer to the client's outstanding request `pos`. */
  deliver(self: Cell<ClientValue>, pos: number, response: Response, step: Step): void;
} = {
  initial: { phase: 'idle' },
  // Giving up is never expected: it is what happens when nothing else can.
  events: (c) =>
    c.phase === 'idle' ? [{ event: 'send', expected: true }] : c.phase === 'waiting' ? [{ event: 'give up' }] : [],
  ingest(self, event, step) {
    if (event === 'give up') net.abort(step.part(NET), CLIENT, 0);
    net.send(step.part(NET), CLIENT, SERVER, 0);
    self.value = { phase: 'waiting' };
  },
  deliver(self, _pos, response, step) {
    if (response === 'ok') self.value = { phase: 'done' };
    else net.send(step.part(NET), CLIENT, SERVER, 0); // an error: try again at once
  },
  describeEvent: (event) => (event === 'send' ? 'the client sends' : 'the client gives up and sends again'),
  describe: (c) => c.phase,
};

/** The server: a counter, and the requests delivered to it that it has not answered. */
interface ServerValue {
  count: number;
  pending: number;
}
type ServerEvent = Response;

const server: Part<ServerValue, ServerEvent> & {
  /** The network delivers a request. */
  deliver(self: Cell<ServerValue>): void;
} = {
  initial: { count: 0, pending: 0 },
  events: (s) => (s.pending === 0 ? [] : [{ event: 'ok', expected: true }, { event: 'error', cost: ['server-error'] }]),
  ingest(self, response, step) {
    const { count, pending } = self.value;
    self.value = { count: response === 'ok' ? count + 1 : count, pending: pending - 1 };
    net.respond(step.part(NET), SERVER, response);
  },
  deliver(self) {
    self.value = { ...self.value, pending: self.value.pending + 1 };
  },
  describeEvent: (response) => (response === 'ok' ? 'the server counts and answers ok' : 'the server answers error'),
  describe: (s) => `count ${s.count}, ${s.pending} pending`,
};

/**
 * The network: every message in flight, oldest first, and for each server
 * the requests in progress there, in delivery order. A request is named by
 * its position among its client's outstanding requests, never by an id; a
 * position of null is an orphan, a request its client gave up on.
 */
type Leg =
  | { kind: 'request'; client: string; server: string; pos: number | null }
  | { kind: 'response'; client: string; pos: number; response: Response };
type Progress = { client: string; pos: number } | null;
interface NetValue {
  inFlight: Leg[];
  inProgress: Record<string, Progress[]>;
}
type NetEvent = { deliver: number } | { lose: number };

/** `n` with every position of `client` above `pos` moved down by one. */
function shifted(n: NetValue, client: string, pos: number): NetValue {
  const down = (p: number | null) => (p !== null && p > pos ? p - 1 : p);
  return {
    inFlight: n.inFlight.map((leg) =>
      leg.client !== client ? leg : leg.kind === 'request' ? { ...leg, pos: down(leg.pos) } : { ...leg, pos: down(leg.pos) ?? leg.pos },
    ),
    inProgress: Object.fromEntries(
      Object.entries(n.inProgress).map(([id, list]) => [
        id,
        list.map((e) => (e !== null && e.client === client ? { ...e, pos: down(e.pos) ?? e.pos } : e)),
      ]),
    ),
  };
}

const net: Part<NetValue, NetEvent> & {
  /** A client sends: its request joins the line, as its outstanding request `pos`. */
  send(self: Cell<NetValue>, client: string, server: string, pos: number): void;
  /** A client gives up on its outstanding `pos`: what the network still holds of it is an orphan. */
  abort(self: Cell<NetValue>, client: string, pos: number): void;
  /** A server answers the oldest request in progress with it. */
  respond(self: Cell<NetValue>, server: string, response: Response): void;
} = {
  initial: { inFlight: [], inProgress: {} },
  // Delivering the oldest message is expected; any other delivery is a
  // reordering, and a loss is a fault with a key of its own.
  events: (n) => [
    ...n.inFlight.map((_, i) => ({ event: { deliver: i }, expected: i === 0 })),
    ...n.inFlight.map((_, i) => ({ event: { lose: i }, cost: ['loss'] })),
  ],
  ingest(self, event, step) {
    const n = self.value;
    const i = 'deliver' in event ? event.deliver : event.lose;
    const leg = n.inFlight[i]!;
    const inFlight = n.inFlight.filter((_, k) => k !== i);
    if ('lose' in event) {
      self.value = { ...n, inFlight };
      return; // whoever waits for it keeps waiting: that is what a loss is
    }
    if (leg.kind === 'request') {
      const entry: Progress = leg.pos === null ? null : { client: leg.client, pos: leg.pos };
      self.value = { inFlight, inProgress: { ...n.inProgress, [leg.server]: [...(n.inProgress[leg.server] ?? []), entry] } };
      server.deliver(step.part(leg.server));
    } else {
      self.value = shifted({ ...n, inFlight }, leg.client, leg.pos);
      client.deliver(step.part(leg.client), leg.pos, leg.response, step);
    }
  },
  send(self, client, server, pos) {
    self.value = { ...self.value, inFlight: [...self.value.inFlight, { kind: 'request', client, server, pos }] };
  },
  abort(self, client, pos) {
    const n = self.value;
    const mine = (leg: Leg) => leg.client === client && leg.pos === pos;
    self.value = shifted(
      {
        inFlight: n.inFlight.flatMap((leg) => (!mine(leg) ? [leg] : leg.kind === 'request' ? [{ ...leg, pos: null }] : [])),
        inProgress: Object.fromEntries(
          Object.entries(n.inProgress).map(([id, list]) => [id, list.map((e) => (e?.client === client && e.pos === pos ? null : e))]),
        ),
      },
      client,
      pos,
    );
  },
  respond(self, server, response) {
    const n = self.value;
    const [head, ...rest] = n.inProgress[server] ?? [];
    const inProgress = { ...n.inProgress, [server]: rest };
    // The answer to an orphan goes nowhere.
    if (head === null || head === undefined) self.value = { ...n, inProgress };
    else self.value = { inProgress, inFlight: [...n.inFlight, { kind: 'response', client: head.client, pos: head.pos, response }] };
  },
  describeEvent(event, n) {
    const leg = n.inFlight['deliver' in event ? event.deliver : event.lose]!;
    const what = leg.kind === 'request' ? (leg.pos === null ? 'the request the client gave up on' : 'the request') : `the ${leg.response} answer`;
    return 'deliver' in event ? `${what} is delivered` : `${what} is lost`;
  },
  describe: (n) =>
    `${n.inFlight.length === 0 ? 'nothing' : n.inFlight.map((leg) => (leg.kind === 'request' ? 'a request' : `an ${leg.response} answer`)).join(', ')} in flight`,
};

// --- The product ----------------------------------------------------------

type Product = Record<string, unknown>;
interface ProductEvent {
  part: string;
  event: unknown;
}

/**
 * The parts as one model. A state is every part's value by id; an event is
 * one part's event; a step gives the parts it touches a cell each, runs the
 * owner's `ingest`, and takes the cells' values back. The events of a state
 * are the candidates first — what the parts expect, in part order, or where
 * nothing is expected each part's first event — then the rest.
 */
function compose(parts: Record<string, Part<unknown, unknown>>): Model<Product, ProductEvent> {
  const ids = Object.keys(parts);
  return {
    initialState: Object.fromEntries(ids.map((id) => [id, parts[id]!.initial])),
    getEvents(state) {
      const offers = ids.flatMap((part) => parts[part]!.events(state[part]).map((offer) => ({ part, ...offer })));
      const expected = offers.filter((offer) => offer.expected);
      const candidates = expected.length > 0 ? expected : ids.flatMap((id) => offers.find((offer) => offer.part === id) ?? []);
      const rest = offers.filter((offer) => !candidates.includes(offer));
      return [...candidates, ...rest].map(({ part, event, cost }) => ({ event: { part, event }, ...(cost ? { cost } : {}) }));
    },
    applyEvent(state, { part, event }) {
      const cells = new Map<string, Cell<unknown>>();
      const step: Step = {
        part: <Value>(id: string) => {
          let cell = cells.get(id);
          if (cell === undefined) cells.set(id, (cell = { value: state[id] }));
          return cell as Cell<Value>;
        },
      };
      parts[part]!.ingest(step.part(part), event, step);
      const to = { ...state };
      for (const [id, cell] of cells) to[id] = cell.value;
      return { to };
    },
    describeEvent: ({ part, event }, state) => parts[part]!.describeEvent(event, state[part]),
    describeState: (state) => ids.map((id) => `${id}: ${parts[id]!.describe(state[id])}`).join('; '),
  };
}

// --- The example ----------------------------------------------------------

export type Property = 'at least one' | 'exactly one';

/** The system, with what must hold wherever it stops: the client is done, and the counter says `property`. */
export function retryingCounter(property: Property): Model<Product, ProductEvent> {
  const model = compose({ [CLIENT]: client, [NET]: net, [SERVER]: server });
  return {
    ...model,
    terminalInvariant(state) {
      const { count } = state[SERVER] as ServerValue;
      if (property === 'at least one' ? count < 1 : count !== 1) return { error: new Error(`the counter is ${count}`) };
      return undefined;
    },
  };
}

/** Explore the system within `faults`, and say what was found. */
export async function report(property: Property, faults: number): Promise<string[]> {
  try {
    const { costs, maxDeviationsReached } = await check(retryingCounter(property), { maxDeviations: faults });
    return [`${property}: holds within ${maxDeviationsReached} faults. ${costs.size} states.`];
  } catch (error) {
    if (!(error instanceof ViolationError)) throw error;
    return `${property}: ${error.message}`.split('\n');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const property of ['at least one', 'exactly one'] as const) {
    console.log((await report(property, 3)).join('\n'));
  }
}
