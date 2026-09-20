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
// deadlocks, and says how far that schedule strays from the expected one. For
// the second it explores every schedule and finds nothing, which, for a fixed
// N, is a proof.
//
//     pnpm build && node examples/dining-philosophers.ts
// ---------------------------------------------------------------------------
import { fileURLToPath } from 'node:url';
import { DEVIATIONS_KEY, StateSpaceCache, exploreIteratively } from 'stifinder';

export type ForkOrder = 'left-first' | 'lowest-first';

export interface Table {
  /** Per philosopher: 0 thinking, 1 holding their first fork, 2 eating. */
  progress: number[];
  /** Whose turn the scheduler says it is. */
  turn: number;
}

/** Philosopher `phil` takes their next step; `does` says which one that is. */
export interface Step {
  phil: number;
  does: string;
}

export function diningPhilosophers(n: number, order: ForkOrder): StateSpaceCache<Table, Step> {
  /** The two forks philosopher `i` needs, in the order they take them. */
  const forksOf = (i: number): number[] => {
    const left = i;
    const right = (i + 1) % n;
    return order === 'lowest-first' && right < left ? [right, left] : [left, right];
  };
  const isHeld = (progress: number[], fork: number) =>
    progress.some((p, i) => forksOf(i).slice(0, p).includes(fork));
  /** What philosopher `i` would do next, or undefined if the fork they want is taken. */
  const nextStep = (progress: number[], i: number): Step | undefined => {
    const wanted = forksOf(i)[progress[i]!];
    if (wanted === undefined) return { phil: i, does: 'puts both forks down' };
    return isHeld(progress, wanted) ? undefined : { phil: i, does: `takes fork ${wanted}` };
  };
  /** Every step that can be taken, starting with the philosopher whose turn it is. */
  const steps = (table: Table): Step[] =>
    table.progress
      .map((_, k) => nextStep(table.progress, (table.turn + k) % n))
      .filter((step) => step !== undefined);

  return new StateSpaceCache<Table, Step>({
    initialState: { progress: Array<number>(n).fill(0), turn: 0 },

    // The expected schedule is a polite one: whoever's turn it is gets to
    // finish their meal undisturbed, and then the turn passes to their
    // neighbour. (If they are waiting for a fork, the next one who can move
    // goes instead.) That is index 0. Anything else, a philosopher cutting in
    // while another is mid-meal, is a deviation.
    async getEvents(table) {
      return steps(table).map((event) => ({ event, cost: [] }));
    },

    async applyEvent(table, { phil }) {
      const progress = table.progress.map((p, i) => (i === phil ? (p + 1) % 3 : p));
      const finishedMeal = progress[phil] === 0;
      const next: Table = { progress, turn: finishedMeal ? (phil + 1) % n : phil };
      // Nobody ever leaves the table, so a state with no step to take is not
      // the end of a run: it is everybody waiting for somebody else.
      if (steps(next).length === 0) return { error: new Error('deadlock') };
      return { to: next };
    },
  });
}

/** Explore the table of `n` under `order`, and say what was found. */
export async function report(n: number, order: ForkOrder): Promise<string[]> {
  const cache = diningPhilosophers(n, order);
  const space = await exploreIteratively(cache);
  if (!space.violation) {
    // No deadlock FOUND is only no deadlock if nothing was left unexplored:
    // no edge still waiting for a larger budget, at any number of deviations.
    const exhausted = space.completed && cache.pending.size === 0 && cache.deferred.length === 0;
    if (!exhausted) return [`${order}: gave up after ${space.edgesComputed} steps.`];
    return [`${order}: no deadlock. ${space.costs.size} states, every schedule explored.`];
  }

  // Budgets are tried in ascending order, so the budget that first fails is
  // the number of deviations the deadlock needs.
  const deviations = space.budget.get(DEVIATIONS_KEY) ?? 0;
  const trace = space.violation.steps;
  const spentBefore = (k: number) => {
    const step = trace[k];
    return step ? (step.cost.get(DEVIATIONS_KEY) ?? 0) : deviations;
  };
  return [
    `${order}: deadlock, ${deviations} deviations from the expected schedule.`,
    ...trace.map(({ event }, k) => {
      const cutIn = spentBefore(k + 1) > spentBefore(k);
      return `  P${event.phil} ${event.does}${cutIn ? '  (cuts in)' : ''}`;
    }),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const order of ['left-first', 'lowest-first'] as const) {
    console.log((await report(5, order)).join('\n'));
  }
}
