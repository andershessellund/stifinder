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
  **`report`**, optional, says how a violation of the model is rendered.

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
budget, which is not yet a proof: the table below says what is. Either
error carries the result too, as `space`, so a test that reports what a
search did (how many states, how far) has it whether the search passed or
failed.

## Code that decides

Code can be explored without a model of it. It asks for its decisions, and
the search makes them:

```ts
import { check, decisionModel } from 'stifinder';

// The code under test: send, and on failure try again, up to `attempts` times.
function deliver(message: string, send: (message: string) => boolean, attempts: number): boolean {
  for (let i = 0; i < attempts; i++) if (send(message)) return true;
  return false;
}

it('delivers unless every attempt fails', async () => {
  const model = decisionModel((decide) => {
    const send = () => !decide.maybe('the send fails', { cost: ['fault'] });
    if (!deliver('hello', send, 3)) throw new Error('gave up');
  });
  await check(model, { baseBudget: { fault: 2 } });
});
```

The body is a function of a `Decisions` object, and `decisionModel` makes
a `Model` of it. **`decide.maybe(label, { cost })`** asks whether something
happens that is not expected to: `false` unless the search is exploring
that deviation, which charges the cost keys given. **`decide.choose(
alternatives)`** picks one of several values, the first being the expected
one, each with a label and cost keys of its own. **`decide.integer(range,
label?)`** picks a number below `range`, 0 being expected; its label says in
words what another pick means, so it suits a yes-or-no, and `choose` suits
the rest. That is how the rest of a system's nondeterminism gets in: a test
double that asks whether to pause, whether to drop the message, which reply
arrives.

The search runs the body once per decision sequence worth trying, fewest
deviations first. Where the body throws, `check` rejects with the report;
without the budget above, that is

```
gave up
3 deviations, 3 steps, fault: 3
  1. the send fails  (deviation, fault)
  2. the send fails  (deviation, fault)
  3. the send fails  (deviation, fault)
in state: decisions [1, 1, 1]
```

A body's report lists the charged steps alone, since the expected steps
have no words of their own. The decisions that led there are
**`decisionsOf(error)`**, and **`runOnce(model, error)`** runs the body once
more with exactly those, under a debugger if you like (it takes the body
too, with a `maxDecisions` of its own where the model's is not the
default).

A run that keeps deciding is cut off past `maxDecisions` (10,000, unless
`decisionModel` is told otherwise; `Infinity` for no cap), and that is a
violation like any other, on the state the run was for: the body does not
end under that schedule. Found after a deviation, it is a livelock the
search has caught; on the expected run, it is the body. No limit of the
search can interrupt a run, so a run that loops, or waits, *without*
deciding is not cut off by anything.

Two requirements. The body must make the same decisions given the same
answers, since it is run again for every prefix; one whose decisions change
between runs is rejected. And a run is complete on the microtask queue:
once the body has returned, or its promise has settled, the run is over,
and nothing the body handed to the macrotask queue is part of it, or of
the model. A timer is not something a body sets; it is something it
models, as a decision of a double that asks whether the timer fires
before the thing it was racing. Either requirement broken, or a wrong use
of `Decisions`, is a **`DecisionsError`**, never a violation: the search
rejects with it, whatever the body does with it, and it says which run's
decisions it happened at. One thing it cannot do is reject the search a
late decision was late for: the search runs in microtasks and is over
before a timer fires, so the error is thrown to the work that decided,
and remembered by the model, which rejects the next search of it. A body
that throws before its first decision, or on the expected run, fails like
any other, and a rejected promise is the body's failure.

## Real code over a simulated network

Code that talks over a network can be explored as it is, against a mock
server, with the network between them simulated: every schedule of
answers, failures, losses and timeouts, fewest faults first.

```ts
import { check, http, mock, program, system } from 'stifinder';
import type { Host } from 'stifinder/host';

// The code under test: fetch, and try again after an error answer, a failed
// connection or a timeout, up to `retries` more times. It takes its host as
// an argument and uses the host's fetch and timeout where it would use the
// globals; in production the host is `webHost()`, the platform itself.
async function fetchWithRetry(host: Host, url: string, retries: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await host.fetch(url, { signal: host.timeoutSignal(1000) });
      if (response.ok || attempt === retries) return response;
    } catch (error) {
      if (attempt === retries) throw error;
    }
  }
}

it('gets an ok answer within as many faults as it retries, and the server counted', async () => {
  const model = system(
    {
      client: program((host) => fetchWithRetry(host, 'https://counter.test/add', 3)),
      net: http({ 'https://counter.test': 'server' }),
      server: mock({ count: 0 }, (state) => [
        { state: { count: state.count + 1 }, response: { status: 200 } },
        { state, response: { status: 500 }, label: 'answers 500', cost: ['server-error'] },
      ]),
    },
    {
      ends: ({ client, server }) => {
        expect(client.result).toEqual({ value: { status: 200 } });
        expect(server.state.count).toBeGreaterThanOrEqual(1);
      },
    },
  );
  await check(model, { maxDeviations: 3 });
});
```

A **system** is parts composed as one model. **`program(main)`** is real
code behind a *host*: `main` runs for real, against a host whose `fetch`
goes to the network and whose timers the search advances. **`http(routes)`**
is the network: it says which server a URL names, and carries every message
in flight, oldest first. **`mock(state, handle)`** is a server as a reducer:
`handle` says how the oldest request is answered, in one way or several,
the first expected and the rest the search's to explore, each with a label
and cost keys. **`ends`** is what must hold wherever the system stops; a
throw is the violation, so an assertion library's `expect` reads as it
should (`invariant` is the same for every state).

The expected run delivers every message at once, in order, and answers the
first way. Everything else is a deviation: a message delivered out of
order, lost (`loss`) or with its connection failed (`failure`), a server's
other answer, a timer fired before the thing it was racing. Each is charged
one deviation and its own keys, so `baseBudget: { loss: 0 }` explores a
world that never loses a message, and `maxDeviations: 3` above is the
claim: no schedule of up to three faults breaks the property. One fault
more and the function gives up, and the search finds the cheapest way,
which is not four refused connections but four answers the client did not
wait for:

```
the client threw: The operation was aborted due to timeout
4 deviations, 17 steps
   4. client waits 1000 ms  (deviation)
   8. client waits 1000 ms  (deviation)
  12. client waits 1000 ms  (deviation)
  16. client waits 1000 ms  (deviation)
in state: client: threw The operation was aborted due to timeout; net: nothing in flight; server: {"count":4}
```

(With `report: { steps: 'charged' }`, as [`examples/fetch-with-retry.ts`](examples/fetch-with-retry.ts)
asks; every step otherwise.) The server counted four times and the client
has nothing: the retry is not idempotent, which a budget of
`{ 'server-error': 0, failure: 0 }` says nothing about, and the search
found on its own.

**What a program part is.** Its state is the log of what the host delivered
and took: the answers and failures of its requests, its timers firing, its
clock moving, the requests it sent. The search explores by value, and runs
`main` again with the log replayed wherever it needs the code at a state it
is not at. Two requirements follow, the same two as for a body that
decides. The code must be a function of its inputs: one that draws
`Math.random()`, reads the clock, or keeps state in a module between runs
departs from its log on replay, and that is a **`SystemError`**, the test's
error, never a violation; the host's `random()` and `uuid()` are a seeded
stream, per part, for that reason. And a step is complete on the
microtask queue: work the code hands to the platform — a real timer, and
also `crypto.subtle`, a compression stream, the file system — finishes
after the step, outside the model, where the search cannot see it. A host
call from such work is a `SystemError` when the model notices it, which it
does when the call comes after the step; one that lands inside the step's
own yield passes as the code's, so the rule is the code's to keep, not the
search's to enforce. A timer the code needs is the host's, which the
search advances as an event. Time is local to each part and relative, so a
wait reads `client waits 1000 ms`, and costs nothing when nothing else can
happen; how time moved is not part of the history, so two runs that waited
differently for the same timers are one state. A `SystemError` is also a
message to a part that does not exist, a rebuilt part that differs from
the live one, which the search checks whenever it resumes one, and a
request the model cannot carry, such as one with a body that is not a
string.

**Parts of your own.** A part is a `Kind`: the value it starts from, the
events its value allows (of the value alone, so that a system of a thousand
parts asks a state for its events without running one), a runtime for a
value, what an event does, what a message from a peer does, and the value
back. A part reaches a peer by id, `step.send(to, message)`, and the system
delivers after the sender's microtasks have drained. **`valuePart(kind)`**
is a part whose runtime is its value, a reducer: `http` and `mock` are two.
A part the test did not name comes to exist when a message first reaches
it, if the system's `kindOf` knows its kind. How it all works is
[DESIGN.md §9.4](DESIGN.md#94-systems-of-parts).

**Where the host lives.** `stifinder/host` exports `Host`, `Timer` and
`webHost()` and imports nothing, so a production bundle that takes a host
carries none of the search; stifinder itself is then in the dependency
list, as the package `webHost` comes from.

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
  `StateSpace`. See [In a test](#in-a-test).
- **`decisionModel(body, options?)`** is a body of code as a
  `Model<DecisionState, number>`, where a state is the decisions made so far
  and an event the next one; see [Code that decides](#code-that-decides).
  `options` are `maxDecisions`, the most one run may make, and `report`. The
  model has `body`, `maxDecisions`, and `runs`, how many times the body has
  been run, by every search of it. **`decisionsOf(violation)`** gives the
  decisions of a violation of such a model, from the path or a
  `ViolationError`; **`runOnce(bodyOrModel, decisions, options?)`** runs
  the body once with those, or with a violation's, and 0 for every decision
  after, under the model's `maxDecisions` given the model, or the option's.
- **`system(parts, options?)`** is parts composed as a
  `Model<SystemState, SystemEvent>`; see [Real code over a simulated
  network](#real-code-over-a-simulated-network). `parts` are the kinds by
  id, in part order; `options` are `kindOf(id)`, the kind of a part that
  comes to exist on first delivery, `invariant` and `ends`, over the parts'
  values by id, `rebuildCheck` (default `true`), and `report`.
  **`partsOf(state)`** gives a state's values by id. **`program(main,
  options?)`** is real code behind a host, with `network` (default `'net'`),
  the part its `fetch` sends to, and `seed`, of its random stream.
  **`http(routes)`** is the network, routing a URL to a server by prefix;
  its cost keys are `loss` and `failure`. **`mock(state, handle)`** is a
  server as a reducer. **`valuePart(kind)`** makes a `Kind` of a part
  written as a reducer. A **`SystemError`** is the test's error, which the
  search rejects with. `stifinder/host` is the `Host` interface and
  `webHost()`, for production code.
- **`formatViolation(violation, model?, options?)`** renders a violation as
  text: the error, what the path cost, each step with what it was charged
  besides the step itself, and the state that failed a check. It uses the
  model's `describeEvent` and `describeState` where there are any; without
  them a string is shown as it is and anything else as JSON. With `{ steps:
  'charged' }`, from `options` or the model's own `report`, only the steps
  charged something are listed. The text is for people, and its wording is
  not API.
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
| `report` | `check` | the model's own | how a `ViolationError` renders the violation: `{ steps: 'all' }` or `{ steps: 'charged' }`, the latter what `decisionModel` asks for |

A run that hits a limit reports `completed: false` and leaves the cache
consistent; the next `explore` on it picks up where it stopped. A throw
from `applyEvent`, `invariant` or `terminalInvariant` is an error of the
model, and a violation like any other. A throw from `getEvents` is not: it
is the search that fails. The call rejects with it, the cache is left just
as consistent, and the next call meets the same throw. That is how a model
says the test itself is wrong, as `decisionModel` does with a
`DecisionsError`.

Budgets are accepted as plain objects or as canonical `ValueMap<string,
number>` values (`BudgetVector`); `toBudget` normalizes either form.

Every allowance in a budget, and `maxEdges` and `timeoutMs`, must be a
number, zero or more, with `Infinity` for no limit (in a budget, the same as
leaving the key out); `maxDeviations` must also be whole. Anything else,
`NaN` included, is a `RangeError`. An option given as `undefined` is one
left out, and its type says so, so a wrapper can pass its own optional
options straight through under `exactOptionalPropertyTypes`.

## Requirements

Node 22 or newer, ES modules, TypeScript types included.

## Working on stifinder

[DESIGN.md](DESIGN.md) describes how it is built, [DECISIONS.md](DECISIONS.md)
why, and [CONTRIBUTING.md](CONTRIBUTING.md) how to change it.

## License

Apache-2.0
