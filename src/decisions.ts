// ---------------------------------------------------------------------------
// Code that decides: a body of code, explored through the decisions it asks
// for.
//
// The body is a function of a `Decisions` object, which it asks at every
// point where more than one thing could happen next: whether a send fails,
// which of two values arrives, which task runs. Under the search:
//
//   state  = the decisions made so far
//   event  = the next decision, 0 first, so that any other pick is a
//            deviation from the expected run
//   applyEvent(prefix, k) = the state one decision longer; the body is run
//            with prefix + [k] replayed and 0 answered to every decision
//            after, and every state along that default continuation is
//            harvested from the one run
//
// A run that throws attributes the error to the last state it reached,
// where the model's `invariant` reports it. So a body that throws before
// its first decision fails at the initial state, and a body that returns a
// promise is awaited. Neither was so in kilde's adapter, which this is the
// move of (D36).
// ---------------------------------------------------------------------------

import { HashMap } from 'valsem';
import type { EventDescriptor, Model } from './search.js';

/** How a pick of `integer` reads in a report: words for a pick that is not
 *  0, or a function of the pick. */
export type DecisionLabel = string | ((pick: number) => string);

/** One of the things `choose` can pick. */
export interface Alternative<T> {
  value: T;
  /** How picking it reads in a report. */
  label?: string;
  /** The cost keys picking it charges, one unit per occurrence. */
  cost?: readonly string[];
}

/**
 * What a body asks when more than one thing could happen next. Every
 * answer is 0, or the first alternative, unless the search is exploring a
 * deviation there.
 */
export interface Decisions {
  /**
   * Pick an integer in [0, range). 0 is the expected pick; any other is a
   * deviation. `label` says what a pick other than 0 means, in words, for
   * the report of a failing run: "sink pauses after value #2". A function
   * is given the pick, for ranges above 2. A range of 1 is no decision.
   */
  integer(range: number, label?: DecisionLabel): number;
  /**
   * Pick one of `alternatives`, and return its value. The first is the
   * expected pick; any other is a deviation, and charges the cost keys it
   * lists. One alternative is no decision.
   */
  choose<T>(alternatives: readonly Alternative<T>[]): T;
}

/** A body of code under test. What it returns is ignored, unless it is a
 *  promise, which is awaited: its rejection is the body's failure. */
export type Body = (decide: Decisions) => unknown;

declare const brand: unique symbol;
/**
 * The decisions made so far, as a state of the search. What it holds is not
 * API, only that it is a value: `describeState` says how it reads, and the
 * events of a violation's steps are the picks.
 */
export interface DecisionState {
  readonly [brand]: 'DecisionState';
}

/** The model of a body, as `decisionModel` builds it. */
export interface DecisionModel extends Model<DecisionState, number> {
  /** How many times the body has been run. */
  readonly runs: number;
}

type Picks = readonly number[];

/** What a decision point offers: its size, how a pick reads, and what each pick charges. */
interface Branch {
  kind: 'branch';
  range: number;
  describe: (pick: number) => string;
  costs: (readonly string[] | undefined)[] | undefined;
}
/** What a run found at a state: a decision to make, its end, or its failure. */
type Entry = Branch | { kind: 'done' } | { kind: 'error'; error: unknown };

/** A wrong use of the harness: thrown through the body, never taken for its failure. */
class Misuse extends Error {}

const describeInteger =
  (label: DecisionLabel | undefined, range: number) =>
  (pick: number): string => {
    if (typeof label === 'function') return label(pick);
    if (label === undefined) return `picked ${pick} of ${range}`;
    if (pick === 0) return `${label}: no`;
    return range > 2 ? `${label} (pick ${pick})` : label;
  };

/**
 * The `Decisions` of one run: replays `picks`, then answers 0. With
 * `expected`, the range each replayed decision had when it was first met,
 * a body whose decisions have changed is caught.
 */
class Replay implements Decisions {
  #index = 0;
  readonly branches: Branch[] = [];

  constructor(
    private readonly picks: Picks,
    private readonly expected: readonly (number | undefined)[] | undefined,
  ) {}

  /** Decision points consulted so far. */
  get consulted(): number {
    return this.#index;
  }

  #decide(branch: Branch): number {
    const i = this.#index++;
    this.branches.push(branch);
    if (i >= this.picks.length) return 0;
    const pick = this.picks[i]!;
    const expected = this.expected?.[i];
    if (expected !== undefined && expected !== branch.range) {
      throw new Misuse(
        `stifinder: decision ${i} had ${expected} alternatives before and ${branch.range} now: the body is not deterministic`,
      );
    }
    if (!Number.isInteger(pick) || pick < 0 || pick >= branch.range) {
      throw new Misuse(`stifinder: decision ${i} has ${branch.range} alternatives, and pick ${pick} is not one of them`);
    }
    return pick;
  }

  integer(range: number, label?: DecisionLabel): number {
    if (!Number.isInteger(range) || range < 1) {
      throw new Misuse(`stifinder: integer(range) needs a whole range of 1 or more, not ${String(range)}`);
    }
    if (range === 1) return 0;
    return this.#decide({ kind: 'branch', range, describe: describeInteger(label, range), costs: undefined });
  }

  choose<T>(alternatives: readonly Alternative<T>[]): T {
    if (alternatives.length === 0) throw new Misuse('stifinder: choose() needs at least one alternative');
    if (alternatives.length === 1) return alternatives[0]!.value;
    const pick = this.#decide({
      kind: 'branch',
      range: alternatives.length,
      describe: (k) => alternatives[k]?.label ?? `alternative ${k}`,
      costs: alternatives.map((a) => a.cost),
    });
    return alternatives[pick]!.value;
  }
}

/**
 * The model of `body`: a state is the decisions made so far, an event the
 * next one. Every callback runs the body at most once per state, and keeps
 * what it finds along the way. `check(body)` is `check(decisionModel(body))`
 * with the report showing the deviations alone; build the model yourself
 * to read `runs` afterwards.
 */
export function decisionModel(body: Body): DecisionModel {
  const table = new HashMap<Picks, Entry>();
  let runs = 0;

  /** Run the body for `picks`, and record every state along its default continuation. */
  async function run(picks: Picks): Promise<void> {
    runs++;
    const expected = picks.map((_, i) => {
      const entry = table.get(picks.slice(0, i));
      return entry?.kind === 'branch' ? entry.range : undefined;
    });
    const replay = new Replay(picks, expected);
    let failure: { error: unknown } | null = null;
    try {
      await body(replay);
    } catch (error) {
      if (error instanceof Misuse) throw error;
      failure = { error };
    }
    if (replay.consulted < picks.length) {
      throw new Misuse(
        `stifinder: the body made ${replay.consulted} decisions, but ${picks.length} had been made before: it is not deterministic`,
      );
    }
    // States along the default chain: picks, picks + [0], picks + [0, 0], …
    let chain = picks;
    for (let i = picks.length; i < replay.branches.length; i++) {
      table.set(chain, replay.branches[i]!);
      chain = [...chain, 0];
    }
    table.set(chain, failure === null ? { kind: 'done' } : { kind: 'error', error: failure.error });
  }

  async function entryFor(picks: Picks): Promise<Entry> {
    const known = table.get(picks);
    if (known !== undefined) return known;
    await run(picks);
    return table.get(picks)!;
  }

  const model: Model<Picks, number> & { readonly runs: number } = {
    initialState: [],
    // A run's failure is a fact about the state it reached: the initial
    // state included, which is what an error reported on edges cannot say.
    async invariant(picks) {
      const entry = await entryFor(picks);
      return entry.kind === 'error' ? { error: entry.error } : undefined;
    },
    async getEvents(picks) {
      const entry = await entryFor(picks);
      if (entry.kind !== 'branch') return [];
      const events: EventDescriptor<number>[] = [];
      for (let k = 0; k < entry.range; k++) {
        const cost = entry.costs?.[k];
        events.push(cost === undefined ? { event: k } : { event: k, cost });
      }
      return events;
    },
    applyEvent: (picks, pick) => ({ to: [...picks, pick] }),
    describeEvent(pick, picks) {
      const entry = table.get(picks);
      return entry?.kind === 'branch' ? entry.describe(pick) : `picked ${pick}`;
    },
    describeState: (picks) => `decisions [${picks.join(', ')}]`,
    get runs() {
      return runs;
    },
  };
  return model as unknown as DecisionModel;
}

/**
 * Run `body` once, with `decisions` replayed and 0 answered to every
 * decision after them: the way to see a reported failure again, under a
 * debugger. Rejects with what the body throws. The decisions of a
 * violation are the events of its steps.
 */
export async function runOnce(body: Body, decisions: readonly number[]): Promise<void> {
  const replay = new Replay(decisions, undefined);
  await body(replay);
  if (replay.consulted < decisions.length) {
    throw new Misuse(`stifinder: the body made ${replay.consulted} decisions of the ${decisions.length} given`);
  }
}
