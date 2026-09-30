// ---------------------------------------------------------------------------
// Dining philosophers, model-checked.
//
// N philosophers sit round a table with one fork between each pair. To eat, a
// philosopher takes two forks, one at a time, and then puts both down. If each
// takes the fork on their left first, all of them can end up holding one fork
// and waiting for the next: a deadlock. If each takes the LOWER-NUMBERED of
// their two forks first, that cannot happen.
//
// stifinder shows both. For the first it finds the shortest schedule that
// deadlocks, and says how far that schedule strays from the expected one, in
// the words the model gives for a step and a table. For the second it
// explores every schedule and finds nothing, which, for a fixed N, is a proof.
//
//     pnpm build && node examples/dining-philosophers.ts
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'node:url';
import { type Model, ViolationError, check } from 'stifinder';

export type ForkOrder = 'left-first' | 'lowest-first';

export interface Table {
  /** Who holds each fork: a philosopher's number, or null while it lies on the table. */
  holder: (number | null)[];
  /** Whose turn the scheduler says it is. */
  turn: number;
}

export type Step =
  | { phil: number; does: 'take'; fork: number }
  | { phil: number; does: 'put down both forks' };

export function diningPhilosophers(n: number, order: ForkOrder): Model<Table, Step> {
  /** The two forks philosopher `phil` needs, in the order they take them. */
  const forksOf = (phil: number): number[] => {
    const left = phil;
    const right = (phil + 1) % n;
    return order === 'lowest-first' && right < left ? [right, left] : [left, right];
  };

  /** What `phil` does next, or undefined while the fork they want is in another's hand. */
  const nextStep = (table: Table, phil: number): Step | undefined => {
    const wanted = forksOf(phil).find((fork) => table.holder[fork] !== phil);
    if (wanted === undefined) return { phil, does: 'put down both forks' };
    return table.holder[wanted] === null ? { phil, does: 'take', fork: wanted } : undefined;
  };

  /** Every step that can be taken, starting with the philosopher whose turn it is. */
  const steps = (table: Table): Step[] =>
    table.holder.map((_, k) => nextStep(table, (table.turn + k) % n)).filter((step) => step !== undefined);

  return {
    initialState: { holder: Array<number | null>(n).fill(null), turn: 0 },

    // The expected schedule is a polite one: whoever's turn it is gets to
    // finish their meal undisturbed, and then the turn passes to their
    // neighbour. (If they are waiting for a fork, the next one who can move
    // goes instead.) That is index 0. Anything else, a philosopher cutting in
    // while another is mid-meal, is a deviation.
    getEvents: (table) => steps(table).map((event) => ({ event })),

    applyEvent: (table, step) =>
      step.does === 'take'
        ? { to: { holder: table.holder.with(step.fork, step.phil), turn: step.phil } }
        : { to: { holder: table.holder.map((h) => (h === step.phil ? null : h)), turn: (step.phil + 1) % n } },

    // Nobody ever leaves the table, so there is no good way for a run to end:
    // a table where nobody can move is everybody waiting for somebody else.
    terminalInvariant: () => ({ error: new Error('deadlock') }),

    // How a step and a table read in a report. A search never calls these.
    describeEvent: (step) => `P${step.phil} ${step.does === 'take' ? `takes fork ${step.fork}` : 'puts down both forks'}`,
    describeState: (table) =>
      table.holder.map((phil, fork) => (phil === null ? `fork ${fork} lies free` : `P${phil} has fork ${fork}`)).join(', '),
  };
}

/** Explore the table of `n` under `order`, and say what was found. */
export async function report(n: number, order: ForkOrder): Promise<string[]> {
  try {
    // As a test would: `check` rejects with the violation, rendered.
    const { exhaustive, costs, maxDeviationsReached } = await check(diningPhilosophers(n, order));
    // Nothing FOUND is only nothing THERE if nothing was left unexplored.
    if (!exhaustive) return [`${order}: no deadlock within ${maxDeviationsReached} deviations.`];
    return [`${order}: no deadlock. ${costs.size} states, every schedule explored.`];
  } catch (error) {
    if (!(error instanceof ViolationError)) throw error;
    return `${order}: ${error.message}`.split('\n');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const order of ['left-first', 'lowest-first'] as const) {
    console.log((await report(5, order)).join('\n'));
  }
}
