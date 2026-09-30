// ---------------------------------------------------------------------------
// check() — a search run as a test: it resolves when the search found
// nothing and looked at everything it was asked to, and rejects otherwise.
// ---------------------------------------------------------------------------

import { decisionModel } from './decisions.js';
import type { Body, DecisionState } from './decisions.js';
import { IncompleteError, ViolationError } from './report.js';
import type { FormatOptions } from './report.js';
import { StateSpaceCache, exploreIteratively } from './search.js';
import type { IterativeOptions, Model, StateSpace } from './search.js';

export interface CheckOptions extends IterativeOptions {
  /**
   * What a search does that `maxEdges` or `timeoutMs` cut short before it
   * found a violation: reject with an `IncompleteError` (`'throw'`, the
   * default), or resolve with `completed: false` (`'allow'`).
   */
  incomplete?: 'throw' | 'allow';
  /** How a `ViolationError` renders the violation. For a body, the default
   *  lists the deviations alone; for a model, every step. */
  report?: FormatOptions;
}

/**
 * Run `exploreIteratively` as a test.
 *
 * Rejects with a `ViolationError` if there is a violation, its message the
 * violation rendered by `formatViolation`. Rejects with an `IncompleteError`
 * if a limit cut the search short before one was found, unless
 * `incomplete: 'allow'`. Otherwise resolves with the `StateSpace`.
 *
 * A search that resolves has cleared its budget. It has cleared the model
 * only if the result is `exhaustive`: a test that means a proof asserts
 * that too.
 *
 * Given a body of code instead of a model, explores the decisions it asks
 * for (`decisionModel`). The report then lists the deviations alone, and
 * ends with the decisions to give `runOnce` to see the failure again.
 */
export function check<State, Event>(
  subject: StateSpaceCache<State, Event> | Model<State, Event>,
  options?: CheckOptions,
): Promise<StateSpace<State, Event>>;
export function check(body: Body, options?: CheckOptions): Promise<StateSpace<DecisionState, number>>;
export async function check(
  subject: StateSpaceCache<unknown, unknown> | Model<unknown, unknown> | Body,
  options?: CheckOptions,
): Promise<StateSpace<unknown, unknown>> {
  const incomplete = options?.incomplete ?? 'throw';
  if (incomplete !== 'throw' && incomplete !== 'allow') {
    throw new RangeError(`stifinder: incomplete must be 'throw' or 'allow', not ${String(incomplete)}`);
  }
  const isBody = typeof subject === 'function';
  const explored = isBody ? (decisionModel(subject) as Model<unknown, unknown>) : subject;
  const report = options?.report ?? (isBody ? { steps: 'deviations' } : {});
  const space = await exploreIteratively(explored, options);
  if (space.violation !== null) {
    throw new ViolationError(space.violation, explored instanceof StateSpaceCache ? explored.model : explored, report);
  }
  if (!space.completed && incomplete === 'throw') throw new IncompleteError(space);
  return space;
}
