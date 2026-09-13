// ---------------------------------------------------------------------------
// spor — generic state-space exploration
//
// Two-layer API:
//
//   1. `StateSpaceCache<State, Event>` — a mutable, budget-independent cache
//      of (state -> events), (state, event -> result), every (state, cost)
//      pair reached so far with its predecessor, and the pending edges not
//      yet traversed. Owns the `ExplorerConfig` so a cache can never be
//      mixed with another config. Reusable across many `explore()` calls;
//      the expensive work is `applyEvent` invocations and they are never
//      repeated.
//
//   2. `explore(cache, budget, options?)` — runs one budget-bounded BFS.
//      Populates the cache as a side effect and returns an `ExploreResult`
//      (statistics only). `analyzeCache(cache, budget)` projects the cache
//      onto a budget: reachable states with their Pareto-minimum costs, the
//      transitions between them, and the shortest violation path.
//
// `exploreIteratively(cache, options?)` calls `explore` with deviation
// budgets 0, 1, 2, … up to a cap, stopping at the first budget that
// exhibits a violation. This produces the minimum-deviation violation
// trace.
//
// `exploreOnce(config, budget, options?)` constructs a fresh cache,
// explores, analyzes, and discards it.
//
// Deviation semantics
// -------------------
// `getEvents(state)` returns events in *preference order*. The event at
// index 0 is the deviation-zero baseline; every other event charges one
// unit of the implicit `__deviations__` budget — regardless of whether
// the index-0 event is affordable under the current budget. This is
// delay-bounded scheduling (Emmi, Qadeer & Rakamarić, POPL 2011) with the
// delay budget generalized to a vector of user-defined cost dimensions.
//
// Ordering of violations
// ----------------------
// "Shortest" is lexicographic: fewest deviations, then smallest total
// non-deviation cost, then fewest steps. Exploration processes deviation
// levels in ascending order and, within a level, pending edges in
// ascending depth. Lower levels are never repopulated by higher ones, so
// the first arrival at a (state, cost) pair is at minimum depth for that
// cost, and the stored predecessors reconstruct minimum-step paths.
// ---------------------------------------------------------------------------

import { HashMap, ValueMap, intern } from 'valsem';

/**
 * A cost vector is an interned `ValueMap<string, number>`: per-key unit
 * counts, missing keys meaning zero. Two structurally-equal vectors are
 * reference-identical (`===`) and carry a precomputed `[hashCode]`,
 * making cache keying and equality cheap.
 */
export type CostVector = ValueMap<string, number>;

/** A budget is a cost vector read as per-key allowances. */
export type BudgetVector = CostVector;

/** Public API input form: accepts either a plain object or a `BudgetVector`. */
export type BudgetLike = BudgetVector | Readonly<Record<string, number>>;

/** Normalize an API-boundary budget input to a canonical `BudgetVector`. */
export function toBudget(b: BudgetLike): BudgetVector {
  return b instanceof ValueMap ? b : ValueMap.fromObject<number>(b);
}

/** Reserved budget key counting non-preferred event choices along a path. */
export const DEVIATIONS_KEY = '__deviations__';

export type ApplyResult<State> = { to: State } | { error: unknown };

/** One event the caller wants the explorer to consider from a state. */
export interface EventDescriptor<Event> {
  event: Event;
  /**
   * Budget keys this event consumes, one unit per occurrence (a key listed
   * twice costs two units). Must not include `__deviations__`; the
   * explorer throws if it does.
   */
  cost: readonly string[];
}

export interface ExplorerConfig<State, Event> {
  initialState: State;
  /**
   * Return the events to consider from `state`, in preference order
   * (most-preferred first). The event at index 0 is always the
   * deviation-zero baseline; every other event charges one unit of the
   * implicit `__deviations__` budget.
   *
   * Must be a pure function of `state`: results are memoized for the
   * lifetime of the cache.
   */
  getEvents(state: State): Promise<EventDescriptor<Event>[]>;
  /**
   * Apply an event to a state. Return `{ to }` for the successor state or
   * `{ error }` for a safety violation. Throwing is treated as `{ error }`.
   *
   * Must be a pure function of `(state, event)`: results are memoized for
   * the lifetime of the cache.
   */
  applyEvent(state: State, event: Event): Promise<ApplyResult<State>>;
}

/** One computed edge out of a state, as listed by `analyzeCache`. */
export type BaseTransition<State, Event> =
  | { event: Event; index: number; cost: readonly string[]; to: State }
  | { event: Event; index: number; cost: readonly string[]; error: unknown };

/** One step of a violation trace: the event applied at `state`, which
 *  had been reached at accumulated cost `cost`. */
export interface ViolationStep<State, Event> {
  state: State;
  /** Cost accumulated from the initial state to `state` (deviations included). */
  cost: CostVector;
  event: Event;
}

export interface ViolationPath<State, Event> {
  steps: ViolationStep<State, Event>[];
  error: unknown;
}

/** Result of a single `explore()` call — pure statistics. The state-space
 *  itself is held by the `StateSpaceCache`; analysis is done via
 *  `analyzeCache(cache, budget)` whenever the projection is actually needed. */
export interface ExploreResult {
  /** True if the BFS exhausted all affordable pending edges; false if
   *  stopped early due to timeout or `maxEdges`. */
  completed: boolean;
  timedOut: boolean;
  /** Edges (i.e. `applyEvent` calls) computed during *this* call (cache misses only). */
  edgesAddedThisRun: number;
  /** Cumulative edges in the cache after this call. */
  edgesComputed: number;
}

/** Projection of the cache at a particular budget — reachable states with
 *  their costs, transitions, and shortest violation. Computed by
 *  `analyzeCache(cache, budget)`. */
export interface CacheAnalysis<State, Event> {
  /** The canonical (interned) initial state — identical to its key in `costs`. */
  initialState: State;
  /** The budget the projection was built for. */
  budget: BudgetVector;
  /** Pareto-minimum cost-to-reach vectors per reachable state, filtered to
   *  costs ≤ `budget`. Cost is intrinsic to the path: the sum of edge
   *  costs (event cost + 1 deviation per non-index-0 event). */
  costs: HashMap<State, CostVector[]>;
  /** Computed transitions out of each state in `costs`. A transition's
   *  `to` state may itself be absent from `costs` when the edge was
   *  computed from a costlier arrival than this budget allows. */
  transitions: HashMap<State, BaseTransition<State, Event>[]>;
  /** Shortest violation path affordable under `budget`, if any. */
  violation: ViolationPath<State, Event> | null;
}

/**
 * Result of `exploreIteratively()` — exploration stats plus a cache
 * projection at the last budget attempted.
 */
export interface StateSpace<State, Event>
  extends ExploreResult, CacheAnalysis<State, Event> {
  /** Highest deviation budget for which exploration completed. -1 if none
   *  completed. When the run stopped early, `budget` is one higher and the
   *  projection at it is partial. */
  maxDeviationsReached: number;
}

export interface ExploreOptions {
  /** Cap on `applyEvent` invocations made by this call. Cache hits are free. Default: 100_000. */
  maxEdges?: number;
  /** Wall-clock cap on this call. */
  timeoutMs?: number;
}

export interface IterativeOptions {
  /** Base budget (deviation key, if present, is overridden per iteration). Default: {}. */
  baseBudget?: BudgetLike;
  /** Deepest deviation budget tried. Default: 100. */
  maxDeviations?: number;
  /** Cap on `applyEvent` invocations across all iterations of this run. Default: 100_000. */
  maxEdges?: number;
  /** Wall-clock cap on the whole run, across all iterations. */
  timeoutMs?: number;
  /** If true (default), stops at the first iteration exhibiting a violation. */
  stopOnViolation?: boolean;
}

export const DEFAULT_MAX_EDGES = 100_000;
export const DEFAULT_MAX_DEVIATIONS = 100;

// ---------------------------------------------------------------------------
// Cost helpers — operate on canonical ValueMap<string, number>.
// Equality is `===` (interned). Comparison still needs entry iteration.
// ---------------------------------------------------------------------------

const EMPTY_COST: CostVector = ValueMap.empty<string, number>();

function costSum(c: CostVector): number {
  let sum = 0;
  for (const v of c.values()) sum += v;
  return sum;
}

/** True iff `a ≤ b` componentwise (missing keys are 0; values are never negative). */
function costLE(a: CostVector, b: CostVector): boolean {
  if (a === b) return true;
  for (const [k, v] of a.entries()) if (v > (b.get(k) ?? 0)) return false;
  return true;
}

/**
 * Add an edge's cost (its cost-key array, plus the deviation charge if
 * `chargesDeviation`) to `base`. Returns a new (interned) vector.
 */
function addCost(base: CostVector, costKeys: readonly string[], chargesDeviation: boolean): CostVector {
  let result = base;
  for (const k of costKeys) result = result.set(k, (result.get(k) ?? 0) + 1);
  if (chargesDeviation) result = result.set(DEVIATIONS_KEY, (result.get(DEVIATIONS_KEY) ?? 0) + 1);
  return result;
}

// ---------------------------------------------------------------------------
// StateSpaceCache
// ---------------------------------------------------------------------------

/** Predecessor of a (state, cost) arrival, for path reconstruction. */
export interface PredecessorEntry<State, Event> {
  from: State;
  fromCost: CostVector;
  event: Event;
}

/** One arrival at a (state, cost) pair. */
export interface CostEntry<State, Event> {
  /** Number of steps from the initial state (minimum for this exact cost). */
  depth: number;
  /** `null` for the initial state's cost-{} entry. */
  pred: PredecessorEntry<State, Event> | null;
}

/** Error edge discovered during exploration. */
export interface ErrorEdgeEntry<State, Event> {
  from: State;
  /** Cost-to-reach `from` at the moment this edge was applied. */
  fromCost: CostVector;
  event: Event;
  /** Total cost to traverse this edge from the initial state
   *  (= `fromCost` + edge cost + optional deviation). */
  totalCost: CostVector;
  /** Number of steps in the violation path ending with this edge. */
  depth: number;
  error: unknown;
}

/** Pending traversal of a single (state, cost, event) edge. `cost` and
 *  `depth` are the **successor's**: `addCost(fromCost, ev.cost, index !== 0)`
 *  and the from-entry's depth + 1. */
export interface PendingEdge<State, Event> {
  from: State;
  fromCost: CostVector;
  event: Event;
  cost: CostVector;
  depth: number;
}

/**
 * Mutable, budget-independent cache of explorer outputs. Owns the
 * `ExplorerConfig` so the cache can never be mixed with another config.
 *
 * Safe to share across many sequential `explore()` calls with different
 * budgets — a richer budget can only enable additional transitions, never
 * invalidate existing ones. Concurrent `explore()` calls on one cache
 * are rejected.
 */
export class StateSpaceCache<State, Event> {
  readonly config: ExplorerConfig<State, Event>;
  /** Canonical (interned) form of `config.initialState`. */
  readonly initialState: State;
  readonly events = new HashMap<State, EventDescriptor<Event>[]>();
  readonly apply = new HashMap<State, HashMap<Event, ApplyResult<State>>>();
  /** Cumulative `applyEvent` invocations (cache misses) across all calls. */
  edgesComputed = 0;

  // ---- Cost model -------------------------------------------------------
  // For each state, every cost vector at which it has been reached that
  // was not dominated by an earlier arrival, with the predecessor and
  // depth of that arrival. Costs are intrinsic to the state space —
  // independent of any exploration budget — so they accumulate across
  // `explore()` calls and are never invalidated. Entries dominated by a
  // later, cheaper arrival are kept so predecessors stay stable; Pareto
  // pruning happens at projection time.
  /** State → cost vector → arrival. Keys are interned, so lookup is `===`. */
  readonly reached = new HashMap<State, Map<CostVector, CostEntry<State, Event>>>();
  /** Cumulative list of error edges discovered. Used by `analyzeCache`. */
  readonly errorEdges: ErrorEdgeEntry<State, Event>[] = [];
  /** Edges not yet traversed, bucketed by successor deviation count and
   *  then by successor depth. Empty (together with `deferred`) means the
   *  entire reachable state space, under any future budget, has been
   *  explored. */
  readonly pending: Map<number, Map<number, PendingEdge<State, Event>[]>> = new Map();
  /** Pending edges found unaffordable in a non-deviation dimension during
   *  some previous call. Re-checked against the budget of every call. */
  deferred: PendingEdge<State, Event>[] = [];

  // ---- Diagnostic counters ---------------------------------------------
  /** Number of `explore()` invocations against this cache. */
  exploreCalls = 0;
  /** Cumulative `getEvents` cache hits. */
  getEventsCacheHits = 0;
  /** Cumulative `applyEvent` cache hits. */
  applyEventCacheHits = 0;

  /** @internal Set while an `explore()` call is in flight. */
  exploring = false;

  constructor(config: ExplorerConfig<State, Event>) {
    this.config = config;
    this.initialState = intern(config.initialState);
  }

  /** Number of distinct states for which `getEvents` has been computed. */
  get statesExplored(): number {
    return this.events.size;
  }

  async getEvents(state: State): Promise<EventDescriptor<Event>[]> {
    const cached = this.events.get(state);
    if (cached !== undefined) { this.getEventsCacheHits++; return cached; }
    const fresh = await this.config.getEvents(state);
    for (const ev of fresh) {
      if (ev.cost.includes(DEVIATIONS_KEY)) {
        throw new Error(`spor: event cost must not include the reserved key ${DEVIATIONS_KEY}`);
      }
    }
    this.events.set(state, fresh);
    return fresh;
  }

  /** True iff `applyEvent(state, event)` has already been computed. */
  hasApplied(state: State, event: Event): boolean {
    return this.apply.get(state)?.has(event) ?? false;
  }

  async applyEvent(state: State, event: Event): Promise<ApplyResult<State>> {
    let bucket = this.apply.get(state);
    if (bucket === undefined) {
      bucket = new HashMap<Event, ApplyResult<State>>();
      this.apply.set(state, bucket);
    } else {
      const cached = bucket.get(event);
      if (cached !== undefined) {
        this.applyEventCacheHits++;
        return cached;
      }
    }
    this.edgesComputed++;
    let result: ApplyResult<State>;
    try {
      result = await this.config.applyEvent(state, event);
    } catch (error) {
      result = { error };
    }
    bucket.set(event, result);
    return result;
  }

  /**
   * Record an arrival at `state` with cost `newCost`. Returns the new
   * entry if the cost is not dominated by (or equal to) an existing one,
   * else `null`.
   *
   * Dominated existing entries are NOT removed — predecessors remain
   * stable for path reconstruction. Pareto pruning is applied at output
   * time by `buildCosts`.
   */
  addCostEntry(
    state: State,
    newCost: CostVector,
    depth: number,
    pred: PredecessorEntry<State, Event> | null,
  ): CostEntry<State, Event> | null {
    let existing = this.reached.get(state);
    if (existing === undefined) {
      existing = new Map();
      this.reached.set(state, existing);
    } else {
      for (const c of existing.keys()) {
        if (costLE(c, newCost)) return null;
      }
    }
    const entry: CostEntry<State, Event> = { depth, pred };
    existing.set(newCost, entry);
    return entry;
  }
}

// ---------------------------------------------------------------------------
// explore() — incremental edge-frontier expansion
//
// The cache holds pending edges: (from, fromCost, event, cost, depth)
// items, each representing one untraversed outgoing edge from a known
// (state, cost) pair, bucketed by successor deviation count and depth.
// Each call drains the deviation levels ≤ the call's budget in ascending
// order, and within a level the depth buckets in ascending order,
// traversing each edge once and seeding new pending edges for newly
// reached (state, cost) pairs. Traversing an edge at level d only seeds
// levels ≥ d, so lower levels never need revisiting. Items in higher
// levels remain for future, richer-budget calls; items unaffordable in a
// non-deviation dimension move to `deferred` and are re-checked against
// every later budget.
// ---------------------------------------------------------------------------

export async function explore<State, Event>(
  cache: StateSpaceCache<State, Event>,
  budget: BudgetLike,
  options?: ExploreOptions,
): Promise<ExploreResult> {
  const timeoutMs = options?.timeoutMs;
  return exploreUntil(cache, toBudget(budget), {
    maxEdges: options?.maxEdges ?? DEFAULT_MAX_EDGES,
    deadline: timeoutMs === undefined ? undefined : Date.now() + timeoutMs,
  });
}

interface Limits {
  /** Cap on cache misses during this call. */
  maxEdges: number;
  /** Absolute `Date.now()` deadline. */
  deadline: number | undefined;
}

async function exploreUntil<State, Event>(
  cache: StateSpaceCache<State, Event>,
  budget: BudgetVector,
  limits: Limits,
): Promise<ExploreResult> {
  if (cache.exploring) {
    throw new Error('spor: explore() called while another explore() on the same cache is in flight');
  }
  cache.exploring = true;
  try {
    return await exploreLocked(cache, budget, limits);
  } finally {
    cache.exploring = false;
  }
}

async function exploreLocked<State, Event>(
  cache: StateSpaceCache<State, Event>,
  budget: BudgetVector,
  limits: Limits,
): Promise<ExploreResult> {
  cache.exploreCalls++;
  const edgesAtStart = cache.edgesComputed;
  const edgeLimit = edgesAtStart + limits.maxEdges;
  const deadline = limits.deadline;

  let timedOut = false;
  let stoppedEarly = false;

  const pushPending = (item: PendingEdge<State, Event>): void => {
    const dev = item.cost.get(DEVIATIONS_KEY) ?? 0;
    let level = cache.pending.get(dev);
    if (level === undefined) {
      level = new Map();
      cache.pending.set(dev, level);
    }
    let bucket = level.get(item.depth);
    if (bucket === undefined) {
      bucket = [];
      level.set(item.depth, bucket);
    }
    bucket.push(item);
  };

  // Seed one pending edge per outgoing event of `state`, reached at `cost`
  // after `depth` steps.
  const seedPending = async (state: State, cost: CostVector, depth: number): Promise<void> => {
    const events = await cache.getEvents(state);
    for (let k = 0; k < events.length; k++) {
      const ev = events[k]!;
      const successorCost = addCost(cost, ev.cost, k !== 0);
      pushPending({ from: state, fromCost: cost, event: ev.event, cost: successorCost, depth: depth + 1 });
    }
  };

  // Lazy seed on first explore call against a fresh cache.
  if (cache.reached.size === 0) {
    cache.addCostEntry(cache.initialState, EMPTY_COST, 0, null);
    await seedPending(cache.initialState, EMPTY_COST, 0);
  }

  // Re-inject every deferred edge that this call's budget can afford.
  if (cache.deferred.length > 0) {
    const stillDeferred: PendingEdge<State, Event>[] = [];
    for (const item of cache.deferred) {
      if (costLE(item.cost, budget)) pushPending(item);
      else stillDeferred.push(item);
    }
    cache.deferred = stillDeferred;
  }

  const budgetDev = budget.get(DEVIATIONS_KEY) ?? 0;

  // Edges deferred this call (unaffordable in a non-deviation dimension).
  // Moved to `cache.deferred` once the loop ends.
  const deferredThisCall: PendingEdge<State, Event>[] = [];

  outer: for (let dev = 0; dev <= budgetDev; dev++) {
    const level = cache.pending.get(dev);
    if (level === undefined) continue;

    while (level.size > 0) {
      let depth = Infinity;
      for (const d of level.keys()) if (d < depth) depth = d;
      const bucket = level.get(depth)!;
      level.delete(depth);

      for (let bi = 0; bi < bucket.length; bi++) {
        const item = bucket[bi]!;

        if (deadline !== undefined && Date.now() >= deadline) {
          timedOut = true;
          for (let r = bi; r < bucket.length; r++) pushPending(bucket[r]!);
          break outer;
        }

        // An item at level `dev` has that many deviations; only the
        // non-deviation dimensions can still be unaffordable.
        if (!costLE(item.cost, budget)) {
          deferredThisCall.push(item);
          continue;
        }

        if (cache.edgesComputed >= edgeLimit && !cache.hasApplied(item.from, item.event)) {
          stoppedEarly = true;
          for (let r = bi; r < bucket.length; r++) pushPending(bucket[r]!);
          break outer;
        }

        const result = await cache.applyEvent(item.from, item.event);
        if ('error' in result) {
          cache.errorEdges.push({
            from: item.from,
            fromCost: item.fromCost,
            event: item.event,
            totalCost: item.cost,
            depth: item.depth,
            error: result.error,
          });
          continue;
        }

        const added = cache.addCostEntry(result.to, item.cost, item.depth, {
          from: item.from,
          fromCost: item.fromCost,
          event: item.event,
        });
        if (added !== null) {
          await seedPending(result.to, item.cost, item.depth);
        }
      }
    }

    cache.pending.delete(dev);
  }

  for (const item of deferredThisCall) cache.deferred.push(item);

  return {
    completed: !timedOut && !stoppedEarly,
    timedOut,
    edgesAddedThisRun: cache.edgesComputed - edgesAtStart,
    edgesComputed: cache.edgesComputed,
  };
}

// ---------------------------------------------------------------------------
// analyzeCache() — project the cache at a given budget
//
// Pure read-only query: builds the per-state Pareto-minimum costs
// (≤ budget), the transition map, and the shortest violation path (if
// any). Independent of `explore()`; can be called any number of times
// against the same cache. Costs O(states × cost-vectors-per-state) for
// `buildCosts`, plus O(transitions) for `buildTransitions`.
// ---------------------------------------------------------------------------

export function analyzeCache<State, Event>(
  cache: StateSpaceCache<State, Event>,
  budget: BudgetLike,
): CacheAnalysis<State, Event> {
  const budgetV = toBudget(budget);
  const costs = buildCosts(cache, budgetV);
  const transitions = buildTransitions(cache, costs);
  const violation = cache.errorEdges.length > 0 ? findShortestViolation(cache, budgetV) : null;
  return {
    initialState: cache.initialState,
    budget: budgetV,
    costs,
    transitions,
    violation,
  };
}

// ---------------------------------------------------------------------------
// exploreIteratively() — convenience wrapper
//
// Each iteration deepens the deviation budget. With the incremental
// cache, iteration d only traverses pending edges at deviation level d
// (plus anything they newly reach). Stops early when the first violation
// appears, or when no pending or deferred edges remain.
// ---------------------------------------------------------------------------

export async function exploreIteratively<State, Event>(
  cache: StateSpaceCache<State, Event>,
  options?: IterativeOptions,
): Promise<StateSpace<State, Event>> {
  const maxDeviations = options?.maxDeviations ?? DEFAULT_MAX_DEVIATIONS;
  const stopOnViolation = options?.stopOnViolation ?? true;
  const baseBudget: BudgetVector = toBudget(options?.baseBudget ?? EMPTY_COST).delete(DEVIATIONS_KEY);
  const maxEdges = options?.maxEdges ?? DEFAULT_MAX_EDGES;
  const deadline = options?.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
  const edgesAtStart = cache.edgesComputed;

  let lastResult: ExploreResult | null = null;
  let lastBudget: BudgetVector = baseBudget.set(DEVIATIONS_KEY, 0);
  let maxDeviationsReached = -1;

  for (let d = 0; d <= maxDeviations; d++) {
    const budget: BudgetVector = baseBudget.set(DEVIATIONS_KEY, d);
    lastBudget = budget;
    const result = await exploreUntil(cache, budget, {
      maxEdges: maxEdges - (cache.edgesComputed - edgesAtStart),
      deadline,
    });
    lastResult = result;
    if (!result.completed) break;
    maxDeviationsReached = d;
    // Cheap violation existence check: O(|errorEdges|), no projection.
    if (stopOnViolation && findShortestViolation(cache, budget) !== null) break;
    // Nothing pending or deferred: the entire reachable state space (under
    // any deviation budget at this non-deviation budget) has been explored.
    if (cache.pending.size === 0 && cache.deferred.length === 0) break;
  }

  // Guarantee a non-null lastResult even if maxDeviations < 0 (defensive).
  if (lastResult === null) {
    lastResult = await exploreUntil(cache, lastBudget, { maxEdges, deadline });
  }

  const analysis = analyzeCache(cache, lastBudget);
  return { ...lastResult, ...analysis, maxDeviationsReached };
}

// ---------------------------------------------------------------------------
// exploreOnce() — one-shot convenience (creates and discards a cache)
// ---------------------------------------------------------------------------

export async function exploreOnce<State, Event>(
  config: ExplorerConfig<State, Event>,
  budget: BudgetLike,
  options?: ExploreOptions,
): Promise<ExploreResult & CacheAnalysis<State, Event>> {
  const budgetV = toBudget(budget);
  const cache = new StateSpaceCache(config);
  const result = await explore(cache, budgetV, options);
  const analysis = analyzeCache(cache, budgetV);
  return { ...result, ...analysis };
}

// ---------------------------------------------------------------------------
// buildCosts — filter cache.reached to states affordable under `budget`
//
// Returns each reachable state with its Pareto-minimum set of cost
// vectors (under the constraint cost ≤ budget). Cached cost entries
// that are dominated by another entry are pruned at output time.
// ---------------------------------------------------------------------------

function buildCosts<State, Event>(
  cache: StateSpaceCache<State, Event>,
  budget: BudgetVector,
): HashMap<State, CostVector[]> {
  const out = new HashMap<State, CostVector[]>();
  for (const [state, arrivals] of cache.reached) {
    const affordable: CostVector[] = [];
    for (const c of arrivals.keys()) {
      if (costLE(c, budget)) affordable.push(c);
    }
    if (affordable.length === 0) continue;

    // Pareto-prune: keep only non-dominated entries. Costs are interned,
    // so distinct entries are distinct vectors.
    const minimal: CostVector[] = [];
    for (const c of affordable) {
      let dominated = false;
      for (const other of affordable) {
        if (other !== c && costLE(other, c)) { dominated = true; break; }
      }
      if (!dominated) minimal.push(c);
    }
    out.set(state, minimal);
  }
  return out;
}

// ---------------------------------------------------------------------------
// buildTransitions — computed edges out of each state in `costs`
// ---------------------------------------------------------------------------

function buildTransitions<State, Event>(
  cache: StateSpaceCache<State, Event>,
  costs: HashMap<State, CostVector[]>,
): HashMap<State, BaseTransition<State, Event>[]> {
  const out = new HashMap<State, BaseTransition<State, Event>[]>();
  for (const [state] of costs) {
    const events = cache.events.get(state);
    if (!events) { out.set(state, []); continue; }
    const bucket = cache.apply.get(state);
    const list: BaseTransition<State, Event>[] = [];
    for (let index = 0; index < events.length; index++) {
      const ev = events[index]!;
      const result = bucket?.get(ev.event);
      if (result === undefined) continue; // never computed (e.g. always unaffordable)
      if ('error' in result) {
        list.push({ event: ev.event, index, cost: ev.cost, error: result.error });
      } else {
        list.push({ event: ev.event, index, cost: ev.cost, to: result.to });
      }
    }
    out.set(state, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// findShortestViolation — pick the best error edge from the cache and
// reconstruct its path via stored predecessors.
//
// Ordered by total deviations, then total non-deviation cost, then
// number of steps — matching `exploreIteratively`'s minimum-deviation
// semantics. Only error edges whose totalCost is affordable under
// `budget` are considered.
// ---------------------------------------------------------------------------

function findShortestViolation<State, Event>(
  cache: StateSpaceCache<State, Event>,
  budget: BudgetVector,
): ViolationPath<State, Event> | null {
  let best: ErrorEdgeEntry<State, Event> | null = null;
  let bestDevs = Infinity;
  let bestSum = Infinity;
  for (const e of cache.errorEdges) {
    if (!costLE(e.totalCost, budget)) continue;
    const devs = e.totalCost.get(DEVIATIONS_KEY) ?? 0;
    const sum = costSum(e.totalCost);
    if (
      devs < bestDevs ||
      (devs === bestDevs && sum < bestSum) ||
      (devs === bestDevs && sum === bestSum && e.depth < best!.depth)
    ) {
      bestDevs = devs;
      bestSum = sum;
      best = e;
    }
  }
  if (best === null) return null;

  // Reconstruct path: walk predecessors back from `best.from` at cost
  // `best.fromCost` to the initial state, then prepend each step.
  const steps: ViolationStep<State, Event>[] = [
    { state: best.from, cost: best.fromCost, event: best.event },
  ];
  let curState: State = best.from;
  let curCost: CostVector = best.fromCost;
  for (;;) {
    const pred = cache.reached.get(curState)?.get(curCost)?.pred;
    if (pred === undefined || pred === null) break; // unknown (impossible) or initial state
    steps.unshift({ state: pred.from, cost: pred.fromCost, event: pred.event });
    curState = pred.from;
    curCost = pred.fromCost;
  }

  return { steps, error: best.error };
}

/**
 * Re-compute the shortest violation path from an analysis, using only
 * its `transitions`. Useful for verifying the embedded path, or after
 * editing the transition table.
 *
 * Runs a BFS over (state, cost) nodes and is independent of the cache.
 * It uses the same ordering as `analysis.violation` (fewest deviations,
 * then least non-deviation cost, then fewest steps), so on an unedited
 * analysis the two agree. Prefer `analysis.violation`; it is much cheaper.
 */
export function shortestViolation<State, Event>(
  analysis: CacheAnalysis<State, Event>,
): ViolationPath<State, Event> | null {
  return shortestViolationFromTransitions(analysis.initialState, analysis.budget, analysis.transitions);
}

function shortestViolationFromTransitions<State, Event>(
  initialState: State,
  budget: BudgetVector,
  transitions: HashMap<State, BaseTransition<State, Event>[]>,
): ViolationPath<State, Event> | null {
  type Node = { state: State; cost: CostVector };
  type Parent = { from: Node; event: Event } | null;
  const parents = new HashMap<Node, Parent>();
  const queue: Node[] = [];

  const root: Node = { state: initialState, cost: EMPTY_COST };
  parents.set(root, null);
  queue.push(root);

  // Plain BFS visits nodes in depth order; among violations found, keep
  // the lexicographically best (devs, sum, depth). Depth is the BFS layer,
  // so the first violation seen at a given (devs, sum) is the shortest.
  let best: { node: Node; event: Event; error: unknown; devs: number; sum: number } | null = null;

  for (let qi = 0; qi < queue.length; qi++) {
    const current = queue[qi]!;
    const trans = transitions.get(current.state);
    if (!trans) continue;

    for (const t of trans) {
      const cost = addCost(current.cost, t.cost, t.index !== 0);
      if (!costLE(cost, budget)) continue;

      if ('error' in t) {
        const devs = cost.get(DEVIATIONS_KEY) ?? 0;
        const sum = costSum(cost);
        if (best === null || devs < best.devs || (devs === best.devs && sum < best.sum)) {
          best = { node: current, event: t.event, error: t.error, devs, sum };
        }
        continue;
      }

      const successor: Node = { state: t.to, cost };
      if (!parents.has(successor)) {
        parents.set(successor, { from: current, event: t.event });
        queue.push(successor);
      }
    }
  }

  if (best === null) return null;
  const steps: ViolationStep<State, Event>[] = [
    { state: best.node.state, cost: best.node.cost, event: best.event },
  ];
  let node: Node = best.node;
  for (;;) {
    const parent = parents.get(node)!;
    if (parent === null) break;
    steps.unshift({ state: parent.from.state, cost: parent.from.cost, event: parent.event });
    node = parent.from;
  }
  return { steps, error: best.error };
}
