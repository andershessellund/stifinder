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
callbacks, two optional checks, and two optional descriptions. The callbacks
and checks may be synchronous or return a promise.

- **`getEvents(state)`** returns the events worth considering from a state,
  in *preference order*. Index 0 is the baseline, the thing that "should"
  happen next. Every other index costs one unit of the implicit
  `__deviations__` key. Every event, at any index, costs one `__steps__`.
- **`applyEvent(state, event)`** returns `{ to: nextState }` or
  `{ error }`. Throwing counts as an error.
- **`invariant(state)`**, optional, returns `{ error }` for a state that must
  never be reached, and nothing for one that is fine. Throwing counts as an
  error here too. It is checked once per distinct state, the initial state
  included, and nothing is explored beyond a state that fails.
- **`terminalInvariant(state)`**, optional, is the same check for the states
  where nothing more can happen: those for which `getEvents` returned `[]`.
  It runs after `invariant` has passed the state.
- **`describeEvent(event, state)`** and **`describeState(state)`**,
  optional, say how an event and a state read in a report. A search never
  calls them: only a violation being rendered does, for its own steps.

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
those states terminal, and its `terminalInvariant` has to expect them. A
`__steps__` allowance bounds them without that: where a budget cuts a run
short is not an end.

For the same reason, offer a fault beside a free event, never as a state's
only event. A fault never has to happen, so a run can end where only faults
remain, and a state that has an event is not checked as an end. With
`[stay, crash]` in place of `[crash]`, not crashing is a step, and where it
leads is an end.

Each event may also list explicit **cost keys**
(`{ event, cost: ['crash', 'retry'] }`); leaving `cost` out means none. A key
listed twice costs two units. Two keys are counted for you, and listing
either is an error: `__deviations__`, and `__steps__`, the length of the
path.

A **budget** gives an allowance per key, and exploration only follows paths
whose accumulated cost stays within it. A key the budget leaves out is not
limited. So `{}` allows everything, `{ crash: 1 }` allows one crash and any
amount of anything else, and `{ __steps__: 50 }` allows runs of up to fifty
steps.

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

## In a test

```ts
import { check } from 'stifinder';

it('the table never deadlocks', async () => {
  const space = await check(diningPhilosophers(5, 'lowest-first'));
  expect(space.exhaustive).toBe(true); // nothing found, and nothing left to look at
});
```

`check` runs `exploreIteratively` and rejects where a test should fail:

- with a **`ViolationError`** when there is a violation. Its message is the
  violation as `formatViolation` renders it: the error, what the path cost,
  and the steps, each in the model's own words where it has a
  `describeEvent`. Its `violation` is the path itself and its `cause` the
  error the model gave.
- with an **`IncompleteError`** when `maxEdges` or `timeoutMs` cut the search
  short before it found anything. A search that stopped early has cleared
  nothing in particular; pass `incomplete: 'allow'` to take its result
  anyway.

Otherwise it resolves with the result. That is a search that cleared its
budget, which is not yet a proof: the table below says what is.

## Code that decides

Code can be explored without a model of it. It asks for its decisions, and
the search makes them:

```ts
import { check } from 'stifinder';

// The code under test: send, and on failure try again, up to `attempts` times.
function deliver(message: string, send: (message: string) => boolean, attempts: number): boolean {
  for (let i = 0; i < attempts; i++) if (send(message)) return true;
  return false;
}

it('delivers unless every attempt fails', async () => {
  await check(
    (decide) => {
      const send = () =>
        decide.choose([
          { value: true, label: 'send succeeds' },
          { value: false, label: 'send fails', cost: ['fault'] },
        ]);
      if (!deliver('hello', send, 3)) throw new Error('gave up');
    },
    { baseBudget: { fault: 2 } },
  );
});
```

The body is a function of a `Decisions` object. **`decide.choose(alternatives)`**
picks one of them and returns its value; the first is what is expected to
happen, and any other is a deviation, charging the cost keys it lists.
**`decide.integer(range, label?)`** picks a number below `range`, 0 being the
expected one, with `label` saying in words what another pick means. That is
how the rest of a system's nondeterminism gets in: a test double that asks
whether to pause, whether to drop the message, which reply arrives.

The search runs the body once per decision sequence worth trying, fewest
deviations first. Where the body throws, `check` rejects with the report:
without the budget above, that is

```
gave up
3 deviations, 3 steps, fault: 3
  1. send fails  (deviation, fault)
  2. send fails  (deviation, fault)
  3. send fails  (deviation, fault)
in state: decisions [1, 1, 1]
```

For a body the report lists the deviations alone, since the expected steps
have no words of their own, and ends with the decisions that led there:
**`runOnce(body, [1, 1, 1])`** runs the body once more with exactly those,
under a debugger if you like.

Two requirements. The body must make the same decisions given the same
answers, since it is run again for every prefix; one whose decisions
change between runs is rejected. And it must not go on deciding after it
has returned, or after the promise it returned has settled. A body that
throws before its first decision, or on the expected run, fails like any
other, and a rejected promise is the body's failure.

**`decisionModel(body)`** is the `Model` behind this, for use with the
rest of the API, and says how many times the body has `runs`.

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
total of your own cost keys, then the fewest steps.

To the search, steps are a cost like any other. A state reached in fewer
steps by more deviations is kept beside the cheaper, longer way to it, so
the cache holds the trade-off, and a budget picks from it:
`analyzeCache(cache, { __steps__: 10 })` reports the violation with the
fewest deviations among those at most ten steps long.

A step allowance is also what keeps a long baseline from standing in the
way. Deviation budget 0 is the whole expected run; if that run is long, or
never ends, no deviation is tried until it is walked to its end. With
`exploreIteratively(model, { baseBudget: { __steps__: 50 } })` each
deviation budget covers the runs of up to fifty steps, and the result is
`exhaustive` only if nothing reaches further.

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

  // How a step and a table read in a report.
  describeEvent: (step) => `P${step.phil} ${step.does === 'take' ? `takes fork ${step.fork}` : 'puts down both forks'}`,
  describeState: (table) =>
    table.holder.map((phil, fork) => (phil === null ? `fork ${fork} lies free` : `P${phil} has fork ${fork}`)).join(', '),
};
```

```
$ pnpm build && node examples/dining-philosophers.ts
left-first: deadlock
4 deviations, 5 steps
  1. P0 takes fork 0
  2. P1 takes fork 1  (deviation)
  3. P2 takes fork 2  (deviation)
  4. P3 takes fork 3  (deviation)
  5. P4 takes fork 4  (deviation)
in state: P0 has fork 0, P1 has fork 1, P2 has fork 2, P3 has fork 3, P4 has fork 4
lowest-first: no deadlock. 214 states, every schedule explored.
```

When everyone reaches for their left fork first, the table can deadlock, and
`check` rejects with the report above as its message: the error, how unlucky
the scheduling has to be (`violation.cost`), the shortest way there
(`violation.steps`, a cut-in marked as the deviation it is), and the table
they end up at (`violation.badState`).
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

- **`check(cacheOrModel, options?)`** is `exploreIteratively` as a test: it
  rejects with a `ViolationError` if there is a violation, and with an
  `IncompleteError` if a limit cut the search short before one was found
  (unless `incomplete: 'allow'`). Otherwise it resolves with the
  `StateSpace`. See [In a test](#in-a-test). **`check(body, options?)`**
  does the same for a body of code, through the decisions it asks for; see
  [Code that decides](#code-that-decides).
- **`decisionModel(body)`** is that body as a `Model<DecisionState, number>`,
  where a state is the decisions made so far and an event the next one, with
  `runs`, how many times the body has been run. **`runOnce(body, decisions)`**
  runs it once with those decisions, and 0 for every one after.
- **`formatViolation(violation, model?)`** renders a violation as text: the
  error, what the path cost, each step with what it was charged besides the
  step itself, and the state that failed a check. It uses the model's
  `describeEvent` and `describeState` where there are any; without them a
  string is shown as it is and anything else as JSON. The text is for
  people, and its wording is not API.
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
  deviations, total of other keys and number of steps, though of several
  that tie it may pick another.

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
| `baseBudget` | iterative | `{}` | allowances for every key but deviations; a key left out is not limited |
| `maxDeviations` | iterative | `100` | deepest deviation budget tried; `Infinity` for no cap |
| `stopOnViolation` | iterative | `true` | stop at the first failing budget |
| `incomplete` | `check` | `'throw'` | what a search cut short by a limit does when it found nothing: reject, or with `'allow'` resolve |
| `report` | `check` | | how a `ViolationError` renders the violation: `{ steps: 'all' }` or `{ steps: 'deviations' }`, the latter the default for a body |

A run that hits a limit reports `completed: false` and leaves the cache
consistent; the next `explore` on it picks up where it stopped. A callback
that throws leaves it just as consistent: the call rejects, and the next one
meets the same throw.

Budgets are accepted as plain objects or as canonical `ValueMap<string,
number>` values (`BudgetVector`); `toBudget` normalizes either form.

Every allowance in a budget, and `maxEdges` and `timeoutMs`, must be a
number, zero or more, with `Infinity` for no limit (in a budget, the same as
leaving the key out); `maxDeviations` must also be whole. Anything else,
`NaN` included, is a `RangeError`.

## Requirements

Node 22 or newer, ES modules, TypeScript types included.

## Working on stifinder

[DESIGN.md](DESIGN.md) describes how it is built, [DECISIONS.md](DECISIONS.md)
why, and [CONTRIBUTING.md](CONTRIBUTING.md) how to change it.

## License

Apache-2.0
