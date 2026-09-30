# stifinder — Design

**Tracks down the shortest, least-surprising failure.** Budget-bounded,
iteratively deepened state-space exploration: given a model of a system and
the schedule it is expected to follow, stifinder finds the violation that
needs the fewest departures from that schedule, or shows that there is none.

This document describes the library as it is: the model, the search, what
the cache holds and what a result proves, in enough detail to work on the
code or to reimplement it. It says *what*; the *why*, the alternatives and
the measurements are in [DECISIONS.md](DECISIONS.md), cited as `D<n>`. User
documentation is the [README](README.md). What is decided but not yet built
is not described here; it is listed under Open in DECISIONS.md.

---

## 1. What stifinder is

Reduced to one sentence:

> **stifinder is one search, over the (state, cost) pairs a model can reach,
> cheapest first, in which nothing is computed twice.**

```ts
const space = await exploreIteratively({
  initialState: { a: 0, b: 0 },
  getEvents: (s) =>
    s.a + s.b >= 6 ? []
    : s.a > s.b ? [{ event: 'tick-b' }, { event: 'tick-a' }]
    : [{ event: 'tick-a' }, { event: 'tick-b' }],
  applyEvent: (s, e) => {
    const next = e === 'tick-a' ? { ...s, a: s.a + 1 } : { ...s, b: s.b + 1 };
    return next.a - next.b > 2 ? { error: new Error('a ran too far ahead') } : { to: next };
  },
});
space.violation?.steps.map((s) => s.index); // [0, 1, 1]: two departures
```

Three properties arrive together:

1. **The failure reported is the least surprising one.** Fewest departures
   from the expected schedule, then least other cost, then fewest steps
   (§6.2).
2. **A result says what it proves.** `exhaustive` with no violation is a
   proof; anything less has cleared a budget (§8).
3. **Deepening is free of rework.** One cache serves every budget, in any
   order, and no callback runs twice for the same arguments (§4).

Around the search is what a test needs of it: a verdict, and a failure a
reader can follow (§9).

### 1.1 Position in the stack

stifinder knows nothing of the system under test. States and events are
whatever the model hands it; equality and hashing come from
[valsem](https://github.com/andershessellund/valsem), its one dependency, a
peer so that the model's values and the cache's keys share one instance
(D26). A test harness or a simulator sits above it and is a `Model`; nothing
of theirs is visible from inside.

### 1.2 Entry point

One: `stifinder`. It ships as ES modules with declarations, for Node 22 or
newer. Members marked `@internal` are left out of the published
declarations (`stripInternal`), so the types a consumer sees are the API
(D22).

---

## 2. The model

### 2.1 What a model is

A `Model<State, Event>` is eight things, the last five optional. The
callbacks and checks may return their result or a promise of it (D9); the
two descriptions return a string, and `report` is a value.

| Part | What it says |
| --- | --- |
| `initialState` | where the system starts |
| `getEvents(state)` | the events worth considering from `state`, in preference order, each with optional cost keys |
| `applyEvent(state, event)` | `{ to }` for the successor, `{ error }` for a failure; a throw is `{ error }` |
| `invariant(state)` | `{ error }` for a state that must never be reached; a throw is `{ error }` |
| `terminalInvariant(state)` | the same, for a state where nothing more can happen |
| `describeEvent(event, state)` | how an event reads where it is taken, for a report |
| `describeState(state)` | how a state reads, for a report |
| `report` | how a violation of the model is rendered, unless the caller says otherwise |

### 2.2 Callbacks are pure, and each result is kept

Every callback must be a function of its arguments alone. The cache keeps
each result for as long as it lives: `getEvents` and both checks per state,
`applyEvent` per (state, event). A callback that reads a clock, a random
source or state outside the model produces a wrong state space, silently.
Why: D1.

The two descriptions are no part of this. A search never calls them; a
report does, for the steps of the one path it renders (§9.2, D28).

### 2.3 States and events are values

The cache interns the initial state, every successor and every event where
it first sees them. From there on they are canonical and frozen: equal
means `===`, a lookup is a probe, results share one copy, and a callback
that mutates a state it was given throws at that step. A value valsem
cannot intern (a `Date`, a native `Map`, an unregistered class instance) is
rejected. Why: D2.

### 2.4 Where an error comes from

Three places, reported the same way and ordered together (§6.2):

- **`applyEvent`**: the system failed while doing something. There is no
  successor state.
- **`invariant`**: a state is wrong in itself. Checked once per distinct
  state, the initial state included.
- **`terminalInvariant`**: a run ended wrong. Checked once per state for
  which `getEvents` returned `[]`.

A state that fails a check is recorded as an error on the edge that led to
it, carrying the state as `badState`; nothing is explored beyond it. The
initial state has no such edge: its failure is kept on the cache and
reported as a violation with no steps and no cost. `badState` is the
cache's to add, and one returned by `applyEvent` is dropped (D8).

The order of calls for a state is fixed: `invariant`, then, if it passed,
`getEvents`, then, if that was empty, `terminalInvariant`. So `getEvents`
never sees a state the invariant rejects. Why two checks and this order:
D5, D6.

### 2.5 Terminal is a property of the model

A state is terminal when `getEvents` returns `[]` for it, and only then. A
state whose events are all beyond the budget has events, and is not shown
to `terminalInvariant`; so a step allowance (§3.2) cuts a run short without
making an end of it. It follows that a model must not offer a fault as a
state's only event: a run may end there, and nothing checks it. A fault
goes beside a free event (D7).

---

## 3. Cost

### 3.1 Cost vectors

A cost is a vector of non-negative counts by key, held as an interned
`ValueMap<string, number>`, so equal vectors are `===`. A missing key is
zero.

An edge costs:

- one unit of the reserved key `__steps__`, always (D31);
- one unit for each occurrence of a key in its event's `cost` (a key listed
  twice costs two);
- one unit of the reserved key `__deviations__` when the event is not at
  index 0 of `getEvents(state)`. The deviation is charged by index alone:
  whichever alternative is taken, and whether or not the index-0 event is
  affordable (D3).

An event may not list a reserved key itself; `getEvents` results that do
are rejected.

The cost of a path is the sum of its edges, so its `__steps__` is its
length. Cost is a property of the path, not of the budget it was found
under.

### 3.2 Budgets

A budget is a vector of allowances by key. A path is within a budget when
its cost is at most the allowance of every key the budget names. A key it
does not name is not limited, and neither is one given `Infinity`: the
empty budget allows everything (D32). Cost and budget thus read a missing
key differently, as zero and as no limit, and are compared by two
functions: one cost against another, and a cost against a budget.

An allowance, `maxEdges` and `timeoutMs` must each be a number, zero or
more, and `maxDeviations` must also be whole; anything else is a
`RangeError` (D21).

### 3.3 Dominance

Costs are partially ordered, componentwise. A state can be reached at
several costs of which none is at most another, so what is kept per state
is a set of arrivals, one per cost (§4). An arrival at a cost that is at
least one already recorded for the state is *dominated*: every path on
from it exists from the cheaper arrival too, at no more cost.

Steps are a key in that order like any other. A way to a state that is
shorter but takes more deviations, or more of a fault, is not dominated by
the longer and cheaper one, and both are kept. A way round a cycle is
dominated by where it started: it costs steps and gains nothing, so no
cycle is walked twice. Why: D4, D13, D31.

---

## 4. The cache

A `StateSpaceCache` owns one model and everything computed from it. Nothing
it stores depends on the budget it was found under, so one cache serves
any sequence of budgets (D16).

| Field | Holds |
| --- | --- |
| `events` | state → its events, with an omitted `cost` filled in as `[]` |
| `apply` | state → event → the edge's result: `{ to }`, or `{ error, badState? }` |
| `invariants` | state → the failure of its checks, or `null` |
| `reached` | state → cost → arrival: the predecessor edge |
| `initialError` | the initial state's failure, if it fails a check |
| `errorEdges` | every error edge found: from, cost before, event, index, total cost, error, `badState` |
| `costCeiling` | the componentwise maximum of every cost recorded |
| `pending` | edges not yet traversed, by the successor's deviations, then its steps |
| `deferred` | edges found beyond a budget in a key other than deviations, steps included |

All of these are `@internal`. The API of a cache is its `model`, the
canonical `initialState`, `exhaustive`, `statesExplored`, and the read-only
counters `edgesComputed`, `exploreCalls`, `getEventsCacheHits` and
`applyEventCacheHits`.

What holds between calls:

- Every arrival recorded has had one edge queued per event of its state.
- A queued edge is in exactly one place: `pending`, `deferred`, or
  traversed and gone.
- `exhaustive` is true once exploration has started and both `pending` and
  `deferred` are empty: every reachable state is in the cache.

One `explore` runs on a cache at a time; a second call while one is in
flight is rejected.

---

## 5. `explore(cache, budget)`

One budget-bounded, breadth-first expansion of the edge frontier.

1. **Seed**, on a fresh cache. Check the initial state; if it passes, ask
   for its events. Record its arrival at the empty cost, keep any failure
   as `initialError`, and queue one edge per event.
2. **Bring back** every deferred edge this budget can afford.
3. **Drain** the deviation levels present, from the lowest, up to the
   budget's deviations. Only levels that exist are visited, so an unbounded
   budget ends where the levels do (D14). Within a level, edges are taken
   by their steps, in turn from the fewest (D12). For each edge:
   - past the deadline: stop, `timedOut`;
   - beyond the budget in another key, steps among them: defer it;
   - at the edge limit, and not already computed: stop;
   - apply it (§2.4). An error is recorded as an error edge, with the cost
     of the path that ends in it;
   - an arrival dominated by one already recorded is skipped;
   - otherwise ask for the successor's events, record the arrival with its
     predecessor, and queue one edge per event, one step further.
4. **Report**: `completed` (no limit was hit), `timedOut`, `exhaustive`
   (§8), and the edges computed by this call and in total.

An edge's cost is its successor's: the cost of the arrival it came from,
plus the edge. `maxEdges` counts `applyEvent` calls, so an edge the cache
already holds is free and never stops a run.

**Order.** Traversing an edge at deviation level *d* queues edges at level
*d* or higher, one step further. Levels run in ascending order and each
level in ascending steps, so lower levels are never refilled, and a call
with *d* deviations touches nothing above them. That a path is the
shortest for what else it costs needs no argument from order: its steps
are part of its cost, and a longer way at the same cost is dominated.

**However a call ends, the cache is consistent** (D18). Whatever can throw,
a callback or valsem rejecting a state, happens before an arrival is
recorded. The untraversed rest of a bucket goes back to `pending`, and
edges deferred during the call go to `deferred`, whether the call returns,
hits a limit or rejects. The next call resumes after a limit, and meets the
same throw after a throw.

**Only `getEvents` can make a call reject.** A throw from `applyEvent`,
`invariant` or `terminalInvariant` is recorded as that edge's or state's
error (§2.4). A throw from `getEvents` is not caught: it is the model
saying that the test is wrong, not that the system is, and `decisionModel`
relies on it (§9.3, D37). That difference is API, and a test pins it.

---

## 6. Reading the cache

### 6.1 `analyzeCache(cache, budget)`

A read-only projection of the cache onto a budget.

- **`costs`**: each state reached within the budget, with its
  Pareto-minimal arrival costs. Steps count: a state reached in fewer steps
  at more of something else has both costs.
- **`transitions`**: the computed edges out of each of those states, each
  with its event, its original `index` and its cost keys. A transition's
  `to` can be missing from `costs`: the edge was computed from an arrival
  the budget does not cover.
- **`violation`**: the shortest violation within the budget, or `null`.

### 6.2 Which violation

"Shortest" is lexicographic: fewest deviations, then the smallest sum of
the model's own cost keys, then the fewest steps (D10). Which of these a
caller cares about is a matter of budget: at `{ __steps__: 10 }` the
violation reported is the one with the fewest deviations among those of at
most ten steps.

A failing initial state comes before everything: it costs nothing and takes
no steps. Otherwise the best error edge whose total cost is within the
budget is picked, and its path is rebuilt by walking stored predecessors
back from the arrival the edge left. Of several violations that tie on all
three, which one is reported follows the order of exploration and is not
specified (D11).

A violation is `{ steps, cost, error, badState? }`. Each step is
`{ state, cost, event, index }`: the event applied at `state`, its position
in `getEvents(state)`, and the cost accumulated *before* it. The
violation's own `cost` includes the failing event, so a budget finds the
path exactly when it allows that much (D20).

### 6.3 `shortestViolation(analysis)`

The same search from the transition table alone: breadth-first over
(state, cost) pairs, skipping a pair dominated by one already seen for its
state, which also makes it end on an unbounded budget (D15). On an unedited
analysis it returns a violation of the same rank as `analysis.violation`,
at more cost.

---

## 7. Iterative deepening

`exploreIteratively(cacheOrModel, options)` calls `explore` with deviation
budgets 0, 1, 2, … on top of `baseBudget`, whose own deviation allowance is
ignored. The base budget bounds the keys it names and no others; by default
it names none. Deviations are the only key deepened (D33): a bound on the
length of a run is a `__steps__` allowance in the base budget, under which
each deviation budget covers the runs that short, and a long baseline does
not have to be walked to its end before a deviation is tried. `maxEdges`
and `timeoutMs` bound the whole run. It stops when:

- a call did not complete;
- the budget just explored has a violation (unless `stopOnViolation:
  false`);
- no larger deviation budget could find anything more: nothing is pending,
  nothing in the cache took more deviations than this budget, and every
  deferred edge needs more than `baseBudget` allows (D19);
- `maxDeviations` is reached.

It returns the last call's result, the projection at the last budget
tried, `maxDeviationsReached` (the highest budget that completed, −1 if
none), and the edges computed by the whole run. Given a model, it uses a
cache of its own; given a cache, the caller keeps it to resume or to
analyze other budgets.

`exploreOnce(model, budget, options)` is one `explore` and one
`analyzeCache` on a cache it discards.

---

## 8. What a result proves

`exhaustive` is true when the cache is exhaustive (§4) and its
`costCeiling` is within the budget of the call: everything the model can
reach has been explored, and the projection at this budget shows all of it
(D17).

| `violation` | `exhaustive` | `completed` | What is known |
| --- | --- | --- | --- |
| set | | `true` | the shortest violation within the budget |
| set | | `false` | one with the fewest deviations within the budget; less other cost may lie where the run did not reach |
| `null` | `true` | `true` | there is no violation |
| `null` | `false` | `true` | none within the budget; more budget may find one |
| `null` | `false` | `false` | a limit was hit; budgets up to `maxDeviationsReached` are clear |

`completed` alone clears a budget. `cache.exhaustive` alone says the cache
holds everything, explored at whatever budgets.

"Everything" is every arrival, not every state: a shorter way to a known
state at more deviations is still to be explored. So a run is exhaustive a
deviation budget or so after its last new edge; the budgets in between
compute nothing, and only traverse what the cache holds (D31).

---

## 9. A search as a test

### 9.1 `check`

`check(cacheOrModel, options)` is `exploreIteratively` with a verdict.

- A violation in the result rejects with a `ViolationError`, whether or not
  the search completed.
- A search cut short by `maxEdges` or `timeoutMs` with nothing found rejects
  with an `IncompleteError`, unless `incomplete: 'allow'`.
- Anything else resolves with the `StateSpace`.

Resolving says the budget is clear, no more (§8). A search bounded on
purpose, by `maxDeviations` or a step allowance, resolves; where a test
means a proof, it asserts `exhaustive` on the result. Why: D34.

### 9.2 The report

`formatViolation(violation, model?)` renders a violation as lines of text:

1. the error: an `Error`'s message, anything else as it is;
2. what the path cost: deviations, steps, then the model's own keys by
   name;
3. one line per step, numbered: the event, then in brackets what the step
   was charged besides the step itself, a deviation (its index is not 0)
   and each of the model's keys that the cost after it holds more of than
   the cost before;
4. the state that failed a check, if one did.

An event is described by `model.describeEvent(event, state)`, with the
state it was taken at, and the failing state by `model.describeState`. This
is the only place either is called. Where a model has no describer, or the
describer throws, the value is shown as it is: a string plainly, anything
else as JSON. A failure being reported is never hidden by the reporting of
it. The text is for people, and its wording is not API. Why: D28, D35.

A `ViolationError` has the report as its message, the path as `violation`,
and the model's error as `cause`. An `IncompleteError` says which limit
stopped the search, how many edges it had computed, and the highest
deviation budget it completed.

With `steps: 'charged'` the report lists only the steps charged something
besides the step itself, under their own numbers. The options come from
the caller, or else from the model's own `report`: a body's model asks for
the charged steps (§9.3), since its expected steps have no words of their
own, so a violation of it reads the same however it is rendered.

### 9.3 Code that decides

`decisionModel(body, options?)` makes a `Model` of a function of a
`Decisions` object, which the body asks at each point where more than one
thing could happen: `maybe(label, { cost })` whether something unexpected
happens, `choose(alternatives)` which of several values, each with a label
and cost keys of its own, `integer(range, label?)` which number below
`range`. The first pick is the expected one; any other is a deviation, and
charges the cost keys of its alternative (the first alternative's are
charged on the expected run). A range of 1, or a single alternative, is no
decision.

- **A state is the decisions made so far**, an interned array of picks. It
  is opaque to a caller (`DecisionState`); `describeState` renders it as
  `decisions [0, 0, 1]`, and `decisionsOf` gives the picks of a violation,
  from its steps' events. **An event is the next pick.**
- **`applyEvent(prefix, k)`** is `prefix + [k]`, and computes nothing.
- **A run is made when a state is first asked about**, by `invariant` or
  `getEvents`: the body runs with the state's picks replayed and 0
  answered to every decision after them. That run reaches, and records on
  the model, every state along its default continuation: what each
  decides, or that it ends there, or the error it throws. So the body runs
  once per leaf of the decision tree, no state is reached twice, and a
  second search of the same model reruns nothing.
- **A failure is a fact about the state the run reached**, reported by
  `invariant`. The initial state is checked like any other, so a body that
  throws before its first decision fails there, with no steps.
- **A promise returned by the body is awaited**, and its rejection is the
  body's failure. The body is told nothing of the search; it must decide
  the same way given the same answers, and must not decide after it has
  returned or settled.
- **A `DecisionsError` is the test's error, never the body's failure**: a
  wrong use of `Decisions` (a range below 1, no alternatives, a replayed
  pick the body does not offer), a body whose decisions have changed (a
  replayed decision has other alternatives than it had, or a run makes
  fewer decisions than it replays), a run past `maxDecisions` (10,000 by
  default), which is what keeps a body whose expected run never ends from
  hanging the search, since no limit of the search can interrupt a run, or
  a decision made once the run is over. The first such error is kept by
  the run's `Decisions`, thrown by every later decision, and recorded on
  the state once the body is done, whatever the body did with it.
  `invariant` reports nothing for such a state, and `getEvents`, which the
  search calls right after, throws it: the one callback whose throw the
  search does not take for an error of the model (§5), so `check` rejects
  with it, at once, and the next search meets it again.
- **A run is over once the body has returned or its promise has settled.**
  A decision after that, from work the body left running, is thrown to
  that work, and remembered by the model, which throws it at the next
  state any search asks about: the search cannot be told at the moment,
  but is told at its next step, or at the first step of the next search.
  A microtask the body queues runs before the run is over, and is a
  decision of the run.
- **Labels** are how a pick reads: an alternative's own, or `maybe`'s and
  `integer`'s label for a pick that is not 0 (a function is given the
  pick; words get the pick added above two alternatives), and the pick
  itself otherwise.
- **The model's `report`** asks for the charged steps alone (§9.2).

`runOnce(body, decisions)` runs the body once with those decisions
replayed, or with a violation's, for seeing a reported failure again; a
decision the body does not offer, or more decisions than it makes, is a
`DecisionsError`. Why: D36, D37.

---

## 10. Verification

`src/oracle.test.ts` checks the search against a brute-force oracle on
seeded random models (D25). The oracle is a breadth-first search over
(state, cost) pairs straight from the model, with no cache, levels,
deferral or dominance. It checks the rank of the violation reported, that
its trace is a real path with the right indexes and costs, that `costs` is
the Pareto frontier within the budget, and that `exhaustive` without a
violation is a proof. It checks them after random histories of calls on
one cache: budgets up and down, runs cut short, callbacks that throw.
`FUZZ_RUNS` and `FUZZ_SEED` run more models, or others.

The other suites, beside the modules they test, pin each documented
behaviour by name, and the regressions. The examples have tests, because
the README quotes their output. CI also runs the suite against the oldest
valsem the peer range admits, and checks the packed tarball's `exports` and
types.

---

## 11. Package layout

| Path | Responsibility |
| --- | --- |
| `src/index.ts` | the one entry point: it exports the three modules below |
| `src/search.ts` | the model, cost helpers, `StateSpaceCache`, `explore`, `analyzeCache`, `exploreIteratively`, `exploreOnce`, `shortestViolation` |
| `src/report.ts` | `formatViolation`, `ViolationError`, `IncompleteError` |
| `src/check.ts` | `check` |
| `src/decisions.ts` | `Decisions`, `decisionModel`, `decisionsOf`, `runOnce`, `DecisionsError` |
| `src/index.test.ts` | behaviour and regressions of the search |
| `src/report.test.ts`, `src/check.test.ts`, `src/decisions.test.ts` | the report, the verdict, and code that decides |
| `src/oracle.test.ts` | the brute-force oracle (§10) |
| `examples/` | runnable models, imported as `stifinder`, which the test config maps to `src/` |
| `scripts/check-commit-message.mjs` | the release-notes check CONTRIBUTING describes |

Releases are made by release-please from PR titles and staged on npm from a
job that builds nothing; CONTRIBUTING.md and SECURITY.md describe both.

---

## 12. Design laws

1. **A result never claims more than was explored.** `exhaustive` is the
   only proof; `completed` clears a budget.
2. **Nothing is computed twice.** Every callback result is kept for the
   life of the cache, across budgets.
3. **Cost belongs to the path**, not to the budget it was found under, and
   a path's length is part of its cost.
4. **The violation reported is the least** by deviations, then other cost,
   then steps, within the budget of a run that completed. Ties are
   unspecified.
5. **Terminal is a property of the model**, not of a budget.
6. **The cache is consistent however a call ends**: completed, stopped by a
   limit, or rejected by a throw.
7. **States and events in results are canonical.** Equal means `===`.
8. **Input that cannot be read is an error**, never a limit read some other
   way. A budget bounds what it names, and nothing else.
9. **The order of exploration is not API**, beyond what the reported
   violation depends on.
10. **A test passes only if the search looked at what it was asked to.**
    Cut short, it fails, unless the test says otherwise.
11. **Reporting a failure never hides it.** A describer that throws is one
    that says nothing.
