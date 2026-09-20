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
  making your own classes values.

## Reading a result

A search that finds nothing has cleared a budget, not the model, unless it
ran out of things to explore. `exhaustive` says which:

| `violation` | `exhaustive` | `completed` | What you know |
| --- | --- | --- | --- |
| set | | | This is the cheapest violation there is (see below). |
| `null` | `true` | `true` | **There is no violation.** Every reachable state was explored, at every budget. |
| `null` | `false` | `true` | None within `maxDeviationsReached` deviations and the `baseBudget`. More budget may find one. |
| `null` | `false` | `false` | The run hit `maxEdges` or `timeoutMs`. Budgets up to `maxDeviationsReached` are clear. |

`completed: true` with `violation: null` reads like a proof and is not one: it
is also what a run capped at `maxDeviations: 3` reports about a failure that
needs four.

## Which violation is reported

"Shortest" is lexicographic: fewest deviations first, then the smallest
total of the other cost keys, then the fewest steps. Exploration runs the
deviation levels in ascending order and each level in ascending depth, so
the first arrival at a (state, cost) pair is the shallowest one, and the
trace reconstructed from stored predecessors has the minimum number of
steps for its cost.

Deviation budgets are *delay bounding* (Emmi, Qadeer & Rakamarić,
"Delay-bounded scheduling", POPL 2011), which generalizes the preemption
bounding of CHESS: a deterministic scheduler with a bounded number of
departures from its default choice. `stifinder` keeps that idea and adds a
vector of user-defined cost dimensions, tracked as a Pareto frontier per
state, plus a cache that survives changes of budget so iterative deepening
never repeats work.

## API

### Two layers

1. **`StateSpaceCache<State, Event>`** owns a `Model` and memoizes
   `getEvents` and `applyEvent` results, every (state, cost) pair reached
   with its predecessor, and the edges not yet traversed. It is
   budget-independent and reusable across many searches in any order of
   budgets; the expensive calls are never repeated. One cache supports one
   `explore` at a time; a concurrent call is rejected.
2. **`explore(cache, budget, options?)`** runs one budget-bounded BFS,
   filling the cache as a side effect. Returns an `ExploreResult` with
   `completed`, `exhaustive`, `timedOut`, and edge counts.

### Helpers

- **`exploreIteratively(cacheOrModel, options?)`** calls `explore` with
  deviation budgets 0, 1, 2, … up to `maxDeviations`, stopping at the first
  budget that exhibits a violation (unless `stopOnViolation: false`) or once
  nothing is left to explore. Returns a `StateSpace`: the `ExploreResult`,
  the projection at the last budget attempted (`costs`, `transitions`,
  `violation`), and `maxDeviationsReached`, the highest budget that
  completed. Given a model, it uses a cache of its own; pass a
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
  from the transition table alone. On an unedited analysis it agrees with
  `analysis.violation`, which is much cheaper.

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
| `maxDeviations` | iterative | `100` | deepest deviation budget tried |
| `stopOnViolation` | iterative | `true` | stop at the first failing budget |

A run that hits a limit reports `completed: false` and leaves the cache
consistent; the next `explore` on it picks up where it stopped.

Budgets are accepted as plain objects or as canonical `ValueMap<string,
number>` values (`BudgetVector`); `toBudget` normalizes either form.

## Requirements

Node 22 or newer, ES modules, TypeScript types included.

## License

Apache-2.0
