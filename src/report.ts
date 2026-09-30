// ---------------------------------------------------------------------------
// A violation, rendered for a reader: what failed, what it took, and the
// steps that led there, in the model's own words where it offers them.
// ---------------------------------------------------------------------------

import { DEVIATIONS_KEY, STEPS_KEY } from './search.js';
import type { CostVector, Model, ViolationPath } from './search.js';

/** The part of a model a report asks: how an event and a state read. */
type Describers<State, Event> = Pick<Model<State, Event>, 'describeEvent' | 'describeState'>;

/** A value shown as it is: a string plainly, anything else as JSON. */
function plain(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || typeof value !== 'object') return String(value);
  try {
    const json: unknown = JSON.stringify(value);
    if (typeof json === 'string') return json;
  } catch {
    // A cycle, or a bigint inside: JSON has no form for it.
  }
  return Object.prototype.toString.call(value);
}

/** What the model says about `value`, or the value as it is if it says
 *  nothing. A describer that throws must not hide the failure being
 *  reported, so it is treated as one that says nothing. */
function described(describe: (() => string | undefined) | undefined, value: unknown): string {
  try {
    const text = describe?.();
    if (typeof text === 'string') return text;
  } catch {
    // Fall through to the plain form.
  }
  return plain(value);
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message === '' ? error.name : error.message;
  return plain(error);
}

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

/** The model's own cost keys in `cost`, in a fixed order. */
function ownKeys(cost: CostVector): string[] {
  return [...cost.keys()].filter((key) => key !== DEVIATIONS_KEY && key !== STEPS_KEY).sort();
}

/** What a whole path cost: "2 deviations, 5 steps, crash: 1". */
function costText(cost: CostVector): string {
  return [
    count(cost.get(DEVIATIONS_KEY) ?? 0, 'deviation'),
    count(cost.get(STEPS_KEY) ?? 0, 'step'),
    ...ownKeys(cost).map((key) => `${key}: ${cost.get(key)}`),
  ].join(', ');
}

/** What one step was charged, besides the step itself: "deviation, crash". */
function chargedText(before: CostVector, after: CostVector, index: number): string {
  const charges = index === 0 ? [] : ['deviation'];
  for (const key of ownKeys(after)) {
    const units = (after.get(key) ?? 0) - (before.get(key) ?? 0);
    if (units > 0) charges.push(units === 1 ? key : `${key} ×${units}`);
  }
  return charges.join(', ');
}

/** `text` with every line after the first indented by `width` spaces. */
const hanging = (text: string, width: number) => text.replaceAll('\n', `\n${' '.repeat(width)}`);

/**
 * Render a violation as text: the error, what the path cost, its steps in
 * order, and the state that failed a check, if one did.
 *
 *     deadlock
 *     4 deviations, 5 steps
 *       1. P0 takes fork 0
 *       2. P1 takes fork 1  (deviation)
 *       ...
 *     in state: P0 has fork 0, P1 has fork 1, ...
 *
 * A step is followed by what it was charged besides the step itself: a
 * deviation, and any of the model's own cost keys. Events and the failing
 * state are described by `model.describeEvent` and `model.describeState`
 * where the model has them, and shown as they are where it does not.
 *
 * The text is for people. Its wording and layout may change in any release.
 */
export function formatViolation<State, Event>(
  violation: ViolationPath<State, Event>,
  model: Describers<State, Event> = {},
): string {
  const { steps } = violation;
  const lines = [errorText(violation.error)];
  lines.push(steps.length === 0 ? 'no steps: the initial state fails' : costText(violation.cost));

  const width = String(steps.length).length;
  for (const [i, step] of steps.entries()) {
    const after = steps[i + 1]?.cost ?? violation.cost;
    const charged = chargedText(step.cost, after, step.index);
    const event = described(model.describeEvent && (() => model.describeEvent?.(step.event, step.state)), step.event);
    const prefix = `  ${String(i + 1).padStart(width)}. `;
    lines.push(`${prefix}${hanging(event, prefix.length)}${charged === '' ? '' : `  (${charged})`}`);
  }

  if ('badState' in violation) {
    const state = violation.badState as State;
    const prefix = 'in state: ';
    lines.push(prefix + hanging(described(model.describeState && (() => model.describeState?.(state)), state), prefix.length));
  }
  return lines.join('\n');
}

/**
 * What `check` rejects with when the search finds a violation. Its message
 * is the violation as `formatViolation` renders it, and its `cause` is the
 * error the model gave.
 */
export class ViolationError<State = unknown, Event = unknown> extends Error {
  /** The violation: its steps, cost, error, and `badState` if a state failed a check. */
  readonly violation: ViolationPath<State, Event>;

  constructor(violation: ViolationPath<State, Event>, model?: Describers<State, Event>) {
    super(formatViolation(violation, model), { cause: violation.error });
    this.name = 'ViolationError';
    this.violation = violation;
  }
}

/**
 * What `check` rejects with when `maxEdges` or `timeoutMs` cut the search
 * short before it found a violation: nothing was found, and not everything
 * within the budget was looked at.
 */
export class IncompleteError extends Error {
  /** True if `timeoutMs` stopped the search, false if `maxEdges` did. */
  readonly timedOut: boolean;
  /** Edges in the cache when the search stopped. */
  readonly edgesComputed: number;
  /** Highest deviation budget the search completed; -1 if none. */
  readonly maxDeviationsReached: number;

  constructor(result: { timedOut: boolean; edgesComputed: number; maxDeviationsReached: number }) {
    const cleared =
      result.maxDeviationsReached < 0
        ? 'no deviation budget is clear'
        : `deviation budgets up to ${result.maxDeviationsReached} are clear`;
    super(
      `stifinder: the search was cut short by ${result.timedOut ? 'timeoutMs' : 'maxEdges'} after ` +
        `${count(result.edgesComputed, 'edge')}: no violation found, and ${cleared}`,
    );
    this.name = 'IncompleteError';
    this.timedOut = result.timedOut;
    this.edgesComputed = result.edgesComputed;
    this.maxDeviationsReached = result.maxDeviationsReached;
  }
}
