// ---------------------------------------------------------------------------
// A remote counter, tested as the code it is.
//
// Two clients each add one to a counter kept by a remote store. The clients
// are ordinary async functions that take the store as an argument; they know
// nothing of stifinder. The test hands them a double of the store, and the
// double is where everything the network could do differently is decided:
// which waiting request the store answers next, and whether a reply is lost
// on the way back.
//
// stifinder finds what each client gets wrong. Read-then-write loses an
// update as soon as the two interleave. Compare-and-set survives every
// interleaving, which the search proves by exploring them all, and counts
// twice once a reply can be lost: the store applied the write, the client
// never heard, and it tried again.
//
//     pnpm build && node examples/remote-counter.ts
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'node:url';
import { type DecisionBody, type Decisions, ViolationError, check, decisionModel } from 'stifinder';

// --- The code under test ---------------------------------------------------

/** What a client needs of the store. */
export interface Store {
  get(): Promise<number>;
  set(value: number): Promise<void>;
  /** Writes `next` if the counter is `expected`, and says whether it did. */
  compareAndSet(expected: number, next: number): Promise<boolean>;
}

/** A store that does not answer in time. */
export class Timeout extends Error {}

/** Read the counter, write it back one higher. */
export async function readThenWrite(store: Store): Promise<void> {
  const n = await store.get();
  await store.set(n + 1);
}

/** Write one higher only if nobody wrote in between, and otherwise try
 *  again, as also after a timeout. */
export async function compareAndSet(store: Store): Promise<void> {
  for (;;) {
    try {
      const n = await store.get();
      if (await store.compareAndSet(n, n + 1)) return;
    } catch (error) {
      if (!(error instanceof Timeout)) throw error;
    }
  }
}

// --- The test double ---------------------------------------------------------

/** Resolves once every promise callback queued so far has run, and those
 *  they queued: a client that got its reply has made its next request. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * The store, behind a network the search controls. A request waits until
 * `run` delivers it; the store then applies it at once, and the reply goes
 * back to the client, or is lost. Nothing here reads a clock or a random
 * source: what a real network leaves to chance, this one asks `decide`.
 */
export class SimulatedStore {
  value = 0;
  readonly #waiting: { name: string; deliver: () => void }[] = [];
  readonly #decide: Decisions;
  readonly #lostReplies: boolean;

  constructor(decide: Decisions, options: { lostReplies: boolean }) {
    this.#decide = decide;
    this.#lostReplies = options.lostReplies;
  }

  /** The store as one client sees it: its requests carry its name. */
  client(name: string): Store {
    return {
      get: () => this.#request(`${name}: get`, () => this.value),
      set: (value) => this.#request(`${name}: set ${value}`, () => void (this.value = value)),
      compareAndSet: (expected, next) =>
        this.#request(`${name}: set ${next} if ${expected}`, () => this.value === expected && ((this.value = next), true)),
    };
  }

  #request<T>(name: string, apply: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.#waiting.push({
        name,
        deliver: () => {
          const result = apply();
          if (this.#lostReplies && this.#decide.maybe(`the reply to ${name} is lost`, { cost: ['lost'] })) {
            reject(new Timeout(name));
          } else resolve(result);
        },
      });
    });
  }

  /**
   * Deliver requests until none is waiting. The expected order is the
   * newest first: a client that has just had its reply is answered again
   * before anyone else is, so each runs to the end undisturbed. Answering
   * an older request first is an interleaving, and a deviation.
   */
  async run(): Promise<void> {
    for (await settle(); this.#waiting.length > 0; await settle()) {
      const newestFirst = this.#waiting.map((_, i) => this.#waiting.length - 1 - i);
      const next = this.#decide.choose(newestFirst.map((i) => ({ value: i, label: `deliver ${this.#waiting[i]!.name}` })));
      this.#waiting.splice(next, 1)[0]!.deliver();
    }
  }
}

// --- The test ----------------------------------------------------------------

export type Client = typeof readThenWrite;

/** Two clients add one each, over a store whose replies are lost or not. */
export function twoIncrements(client: Client, options: { lostReplies: boolean }): DecisionBody {
  return async (decide) => {
    const store = new SimulatedStore(decide, options); // a new world for every run
    const done = Promise.all([client(store.client('A')), client(store.client('B'))]);
    await store.run(); // every decision is made in here, and awaited
    await done;
    if (store.value !== 2) throw new Error(`counted ${store.value}, not 2`);
  };
}

/** Explore two increments with `client`, and say what was found. */
export async function report(client: Client, options: { lostReplies: boolean }): Promise<string[]> {
  const name = `${client.name}${options.lostReplies ? ', replies lost' : ''}`;
  try {
    const { exhaustive, maxDeviationsReached } = await check(decisionModel(twoIncrements(client, options)), {
      baseBudget: { lost: 1 },
    });
    if (!exhaustive) return [`${name}: correct within ${maxDeviationsReached} deviations.`];
    return [`${name}: correct, every schedule explored.`];
  } catch (error) {
    if (!(error instanceof ViolationError)) throw error;
    return `${name}: ${error.message}`.split('\n');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [client, lostReplies] of [
    [readThenWrite, false],
    [compareAndSet, false],
    [compareAndSet, true],
  ] as const) {
    console.log((await report(client, { lostReplies })).join('\n'));
  }
}
