# stifinder

**Tracks down the shortest, least-surprising failure.** Budget-bounded,
iteratively deepened state-space exploration for JavaScript:

```ts
import { exploreIteratively } from 'stifinder';

// Two counters advanced by a scheduler that prefers to keep them level.
const space = await exploreIteratively({
  initialState: { a: 0, b: 0 },
  getEvents(s) {
    if (s.a + s.b >= 6) return []; // six ticks per run
    // Preference order: index 0 is what the fair scheduler would do next;
    // anything else is a deviation from the expected schedule.
    return s.a > s.b
      ? [{ event: 'tick-b' }, { event: 'tick-a' }]
      : [{ event: 'tick-a' }, { event: 'tick-b' }];
  },
  applyEvent(s, e) {
    const next = e === 'tick-a' ? { ...s, a: s.a + 1 } : { ...s, b: s.b + 1 };
    if (next.a - next.b > 2) return { error: new Error('a ran too far ahead') };
    return { to: next };
  },
});

space.violation?.steps.map((s) => s.event);
// ['tick-a', 'tick-a', 'tick-a']
space.violation?.steps.map((s) => s.index);
// [0, 1, 1] — the first tick is the expected one; the error needs the scheduler to stray twice
space.maxDeviationsReached;
// 2 — budgets 0 and 1 were exhausted without a failure; budget 2 is the first that fails
```

*Stifinder* is Danish for "pathfinder" (*sti*: path), and that is what the
library is: it finds the path to a violation that needs the fewest departures
from the expected schedule. It is the search core of a
deterministic-simulation test harness, kept independent of any particular
system under test. States and events are whatever you hand it; equality and
hashing come from [`valsem`](https://github.com/andershessellund/valsem), so
structurally equal states are explored once.

```bash
npm install stifinder valsem
```

> `valsem` is a peer dependency. The explorer keys its caches by structural
> equality, so it must share one `valsem` instance with your state and event
> types.

## The model

You describe a system as a `Model<State, Event>`: an `initialState`, two
callbacks, and two optional checks. Each may be synchronous or return a
promise.

- **`getEvents(state)`** returns the events worth considering from a state,
  in *preference order*. Index 0 is the baseline, the thing that "should"
  happen next. Every other index costs one unit of the implicit
  `__deviations__` budget.
- **`applyEvent(state, event)`** returns `{ to: nextState }` or
  `{ error }`. Throwing counts as an error.
- **`invariant(state)`**, optional, returns `{ error }` for a state that must
  never be reached, and nothing for one that is fine. Throwing counts as an
  error here too. It is checked once per distinct state, the initial state
  included, and nothing is explored beyond a state that fails.
- **`terminalInvariant(state)`**, optional, is the same check for the states
  where nothing more can happen: those for which `getEvents` returned `[]`.
  It runs after `invariant` has passed the state.

So an error can come from three places. `applyEvent` is where the system under
test fails *while doing something*: it threw, and there is no next state.
`invariant` is where a state is wrong *in itself*, whichever event led there:
two leaders, a negative balance. `terminalInvariant` is where a run *ends*
wrong: everybody waiting for somebody else, a message never delivered,
replicas that did not converge. It is what tells an acceptable end from a
deadlock. For the last two the violation carries the state, as `badState`.

An end is a property of the model, not of a budget: a state whose events are
all unaffordable is not terminal, and is not shown to `terminalInvariant`. A
model that bounds its runs by returning `[]` after so many steps does make
those states terminal, and its `terminalInvariant` has to expect them.

Each event may also list explicit **cost keys**
(`{ event, cost: ['crash', 'retry'] }`); leaving `cost` out means none. A key
listed twice costs two units. A budget is a vector of per-key
allowances, and exploration only follows paths whose accumulated cost stays
within it. Deviation counting is automatic; other keys are yours to define.
Listing `__deviations__` as a cost key is an error.

Two requirements, both consequences of caching:

- **Every callback must be a pure function of its arguments.** Results are
  memoized for the lifetime of a cache, so a callback that consults a clock,
  a random source, or mutable state outside the model silently produces a
  wrong state space.
- **States and events must be values `valsem` can intern**: plain objects,
  arrays, primitives, and its own collections. A `Date`, a native `Map`, or
  an unregistered class instance is rejected. See valsem's guide on
  [extending](https://github.com/andershessellund/valsem#extending) for
  making your own classes values. The cache interns each state and event
  once, so the ones your callbacks receive and the ones in results are
  canonical and frozen: equal means `===`, and a callback that mutates a
  state it is given throws there.

## Reading a result

A search that finds nothing has cleared a budget, not the model, unless it
ran out of things to explore. `exhaustive` says which:

| `violation` | `exhaustive` | `completed` | What you know |
| --- | --- | --- | --- |
| set | | `true` | The cheapest violation within the budget (see below). |
| set | | `false` | One with the fewest deviations within the budget. One with less other cost may lie where the run did not reach; resuming on a kept cache finishes the search. |
| `null` | `true` | `true` | **There is no violation.** Every reachable state was explored, whatever budget it takes, and all of them are within this result's budget. |
| `null` | `false` | `true` | None within `maxDeviationsReached` deviations and the `baseBudget`. More budget may find one. |
| `null` | `false` | `false` | The run hit `maxEdges` or `timeoutMs`. Budgets up to `maxDeviationsReached` are clear. |

`completed: true` with `violation: null` reads like a proof and is not one: it
is also what a run capped at `maxDeviations: 3` reports about a failure that
needs four.

A completed run stops short of `maxDeviations` only at a violation, or where
no larger deviation budget could find anything more. Stopped there without a
violation and not `exhaustive`, it has left something that only a larger
`baseBudget` can reach. On a kept cache, explored earlier at a larger budget,
a result is `exhaustive` only once its own budget covers everything the cache
holds.

## Which violation is reported

"Shortest" is lexicographic: fewest deviations first, then the smallest
total of the other cost keys, then the fewest steps. Exploration runs the
deviation levels in ascending order and each level in ascending depth, so
the first arrival at a (state, cost) pair is the shallowest one, and the
trace reconstructed from stored predecessors has the minimum number of
steps for its cost.

Violations can tie on all three. Which of them is reported is not
specified: it follows the order of exploration, which may change between
releases. Any of them is as short as the others.

Deviation budgets follow *delay bounding* (Emmi, Qadeer & Rakamarić,
"Delay-bounded scheduling", POPL 2011), which generalizes the preemption
bounding of CHESS: a deterministic scheduler with a bounded number of
departures from its default choice. One difference: a delay skips one
task, so taking the scheduler's k-th alternative costs k delays, while here
any departure costs one deviation, whichever alternative it takes.
`stifinder` adds a vector of user-defined cost dimensions, tracked as a
Pareto frontier per state, plus a cache that survives changes of budget so
iterative deepening never repeats work.

## An example: dining philosophers

[`examples/dining-philosophers.ts`](examples/dining-philosophers.ts) models
the classic table: five philosophers, a fork between each pair, and a
philosopher needs both of theirs to eat. The state is who holds each fork,
and whose turn it is. The expected schedule is a polite one: whoever's turn
it is finishes their meal undisturbed, then the turn passes to their
neighbour. A philosopher cutting in while another is mid-meal is a deviation.

```ts
return {
  initialState: { holder: Array(n).fill(null), turn: 0 },

  // Every step that can be taken, starting with the philosopher whose turn it is.
  getEvents: (table) => steps(table).map((event) => ({ event })),

  applyEvent: (table, step) =>
    step.does === 'take'
      ? { to: { holder: table.holder.with(step.fork, step.phil), turn: step.phil } }
      : { to: { holder: table.holder.map((h) => (h === step.phil ? null : h)), turn: (step.phil + 1) % n } },

  // Nobody ever leaves the table, so any end is everybody waiting for somebody else.
  terminalInvariant: () => ({ error: new Error('deadlock') }),
};
```

```
$ pnpm build && node examples/dining-philosophers.ts
left-first: deadlock, 4 deviations from the expected schedule.
  P0 takes fork 0
  P1 takes fork 1  (cuts in)
  P2 takes fork 2  (cuts in)
  P3 takes fork 3  (cuts in)
  P4 takes fork 4  (cuts in)
  and there they sit: P0 has fork 0, P1 has fork 1, P2 has fork 2, P3 has fork 3, P4 has fork 4.
lowest-first: no deadlock. 214 states, every schedule explored.
```

When everyone reaches for their left fork first, the table can deadlock, and
the report says how: the shortest way there (`violation.steps`, with each
step's `index` telling a cut-in from a turn), how unlucky the scheduling has
to be (`violation.cost`), and the table they end up at (`violation.badState`).
Budgets 0 to 3 were exhausted first, so no schedule with fewer than four
interruptions deadlocks. When everyone reaches for the lower-numbered of their
two forks first, the result is `exhaustive` and has no violation. That is a
proof, of exactly what was modelled: five philosophers. It says nothing about
six.

## API

### Two layers

1. **`StateSpaceCache<State, Event>`** owns a `Model` and memoizes
   `getEvents` and `applyEvent` results, every (state, cost) pair reached
   with its predecessor, and the edges not yet traversed. It is
   budget-independent and reusable across many searches in any order of
   budgets; the expensive calls are never repeated. One cache supports one
   `explore` at a time; a concurrent call is rejected. What it stores is
   internal: a cache offers its `model`, the canonical `initialState`,
   `exhaustive` (the whole reachable state space is in it), `statesExplored`,
   and the read-only counters `edgesComputed`, `exploreCalls`,
   `getEventsCacheHits` and `applyEventCacheHits`.
2. **`explore(cache, budget, options?)`** runs one budget-bounded BFS,
   filling the cache as a side effect. Returns an `ExploreResult` with
   `completed`, `exhaustive`, `timedOut`, and edge counts.

### Helpers

- **`exploreIteratively(cacheOrModel, options?)`** calls `explore` with
  deviation budgets 0, 1, 2, … up to `maxDeviations`, stopping at the first
  budget that exhibits a violation (unless `stopOnViolation: false`) or once
  no larger deviation budget could find anything more. Returns a
  `StateSpace`: the `ExploreResult`, the projection at the last budget
  attempted (`costs`, `transitions`, `violation`), and
  `maxDeviationsReached`, the highest budget that completed. Given a
  model, it uses a cache of its own; pass a
  `StateSpaceCache` to keep it, to resume a run that hit a limit or to
  analyze other budgets afterwards.
- **`exploreOnce(model, budget, options?)`** builds a fresh cache, explores,
  analyzes, and discards it.
- **`analyzeCache(cache, budget)`** projects the cache onto a budget without
  exploring: reachable states with their Pareto-minimum costs, the computed
  transitions out of each (with the event's original `index`, so index 0 is
  still the baseline), and the shortest violation path. A transition's `to`
  state can be absent from `costs` when the edge was computed from an
  arrival the budget does not cover.
- **`shortestViolation(analysis)`** recomputes the shortest violation path
  from the transition table alone. On an unedited analysis it finds one of
  the same rank as `analysis.violation`, which is much cheaper: the same
  cost and number of steps, though of several that tie it may pick another.

A violation is `{ steps, cost, error, badState? }`, where each step is
`{ state, cost, event, index }`: the event applied at `state`, its position
in `getEvents(state)` (0 is the baseline, anything else was charged a
deviation), and the cost accumulated from the initial state to reach `state`.
A step's `cost` is the cost *before* it; the violation's own `cost` is the
cost of the whole path, the failing event included: a budget finds this
path exactly when it allows that much. `badState` is present when the error
is a state failing `invariant` or `terminalInvariant`: the state the last
step led to, or the initial state, in which case `steps` is empty. All kinds
of error are ordered together, so the cheapest violation is reported
whichever it is.

### Options

| Option | Applies to | Default | Meaning |
| --- | --- | --- | --- |
| `maxEdges` | all | `100_000` | cap on `applyEvent` calls per `explore` call, or per `exploreIteratively` run; cache hits are free |
| `timeoutMs` | all | none | wall-clock cap per `explore` call, or per `exploreIteratively` run |
| `baseBudget` | iterative | `{}` | non-deviation allowances |
| `maxDeviations` | iterative | `100` | deepest deviation budget tried; `Infinity` for no cap |
| `stopOnViolation` | iterative | `true` | stop at the first failing budget |

A run that hits a limit reports `completed: false` and leaves the cache
consistent; the next `explore` on it picks up where it stopped. A callback
that throws leaves it just as consistent: the call rejects, and the next one
meets the same throw.

Budgets are accepted as plain objects or as canonical `ValueMap<string,
number>` values (`BudgetVector`); `toBudget` normalizes either form.

Every allowance in a budget, and `maxEdges` and `timeoutMs`, must be a
number, zero or more, with `Infinity` for no limit; `maxDeviations` must also
be whole. Anything else, `NaN` included, is a `RangeError`.

## Requirements

Node 22 or newer, ES modules, TypeScript types included.

## License

Apache-2.0
