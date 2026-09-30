// ---------------------------------------------------------------------------
// check() — a search run as a test: it resolves when the search found
// nothing and looked at everything it was asked to, and rejects otherwise.
// ---------------------------------------------------------------------------

import { IncompleteError, ViolationError } from './report.js';
import { StateSpaceCache, exploreIteratively } from './search.js';
import type { IterativeOptions, Model, StateSpace } from './search.js';

export interface CheckOptions extends IterativeOptions {
  /**
   * What a search does that `maxEdges` or `timeoutMs` cut short before it
   * found a violation: reject with an `IncompleteError` (`'throw'`, the
   * default), or resolve with `completed: false` (`'allow'`).
   */
  incomplete?: 'throw' | 'allow';
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
 */
export async function check<State, Event>(
  subject: StateSpaceCache<State, Event> | Model<State, Event>,
  options?: CheckOptions,
): Promise<StateSpace<State, Event>> {
  const incomplete = options?.incomplete ?? 'throw';
  if (incomplete !== 'throw' && incomplete !== 'allow') {
    throw new RangeError(`stifinder: incomplete must be 'throw' or 'allow', not ${String(incomplete)}`);
  }
  const space = await exploreIteratively(subject, options);
  if (space.violation !== null) {
    throw new ViolationError(space.violation, subject instanceof StateSpaceCache ? subject.model : subject);
  }
  if (!space.completed && incomplete === 'throw') throw new IncompleteError(space);
  return space;
}
