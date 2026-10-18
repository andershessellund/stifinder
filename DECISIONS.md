# Decisions

Why stifinder is built the way it is, and not some other way. One entry per
decision, in its final form: what was chosen, the alternatives that were
rejected and the evidence that rejected them, and the cost accepted. When a
decision changes, its entry is rewritten and the old choice becomes a
rejected alternative; git history keeps the sequence. Entries are grouped by
topic, and the `D` numbers are stable identifiers, not an order.

How the mechanisms work is [DESIGN.md](DESIGN.md)'s job; an entry here
states the decision and points there. Numbers quoted are the measurements
at the time of the decision. Where the evidence is a counterexample, it is
kept as a test, and the entry names it. `(#n)` is the pull request in which
the decision was made; its description has the detail. An entry whose reason
was not written down at the time says so, and does not supply one afterwards.

## The model

### D1. A model is an initial state and pure callbacks, and every result is kept

`getEvents`, `applyEvent`, `invariant` and `terminalInvariant` must be
functions of their arguments alone. The cache keeps each result for as long
as it lives.

**Why.** The expensive work is `applyEvent`: for a simulator, running the
system under test one step. Iterative deepening visits the same states at
every budget, so with kept results each deeper budget pays only for what is
new, and a cache can be resumed after a limit or asked about other budgets
at no cost. **Cost.** Purity is required and is not checked: a callback
that reads a clock, a random source or state outside the model produces a
wrong state space, silently. The cache holds every state it has seen.
DESIGN.md §2.2, §4.

### D2. States and events are valsem values, interned where the cache first sees them (#17)

The initial state, every successor and every event are interned once, on
first sight. Callbacks receive, and results hold, canonical frozen values.

**Why.** Structural equality is what makes a state reached a second way the
same state. Interned once, every later lookup is a probe instead of a walk,
results share one copy, and a model that mutates a state it was given fails
at that step. **Rejected:** interning only the initial state and
`badState`, the earlier form. Successors were hashed by walking them at
each lookup: exploring a model with 400-number states and a cost key took
797 ms and takes 131 ms, and the dining philosophers take half as long. And
a model that mutated a state silently changed the cache's copy; a test
shows the trace it used to corrupt. **Cost.** States and events must be
values valsem can intern: a `Date`, a native `Map` or an unregistered class
instance is rejected. A mutating model now throws a `TypeError`, reported
as the violation. DESIGN.md §2.3.

### D3. Events come in preference order, and any departure from index 0 costs one deviation

`getEvents` returns events most-preferred first. Index 0 is the baseline;
taking any other index charges one unit of `__deviations__`, whichever
index it is, and whether or not the index-0 event is affordable.

**Why.** The baseline is the schedule the model's author expects, and a
failure is measured by how far it strays from it. This follows delay
bounding (Emmi, Qadeer & Rakamarić, "Delay-bounded scheduling", POPL 2011):
a deterministic scheduler with a bounded number of departures from its
default choice.

Delay bounding charges *k* for the scheduler's *k*-th alternative, since a
delay skips one task. Why stifinder charges one was not written down when
it was built; the difference was noticed in review (#17). The case for it,
as argued on 2026-09-30: the flat charge is the more primitive of the two.
A model gets delay bounding exactly by offering `[run next, delay]` with
the scheduler's cursor in its state, where each delay is index 1; nothing
built on a charge by index could say that two alternatives are equally
surprising, which is what they are when they are a set and not a queue
(which philosopher cuts in, which value a decision picks). In the dining
philosophers every cut-in is index 1, and both charges count four.
**Rejected:** charging the index. What it buys is real: with *I*
scheduling points and *C* choices at each, *K* delays reach at most *I^K*
schedules, independent of *C*, where the flat charge reaches about
*(I·C)^K*. For sixteen tasks of three steps and a budget of 3, that is
18,262 complete schedules against 7,898,781, and an empirical study of 52
buggy programs found delay bounding the better of the two (Thomson,
Donaldson & Betts, PPoPP 2014). But a model with wide menus can have it by
the encoding above, at one more state and step per delay. **Not recorded:**
why the charge ignores whether index 0 is affordable. **Cost.** A wide flat
menu multiplies every deviation budget by its width. How a deviation is
charged is API: changing it is a major version (D23). A charge the model
sets per event is under Open. DESIGN.md §3.1.

### D4. Cost is a vector of named keys, and a budget a vector of allowances

An event lists the keys it consumes, one unit per occurrence. A path's cost
is the sum; a budget allows so much of each key it names (D32).
`__deviations__` and `__steps__` (D31) are keys of the same vector,
reserved: they are counted by the search, and an event that lists either is
rejected.

**Why.** A system's faults are of different kinds, and a test bounds them
separately: one lost message, no crash, any number of reorderings. The
Durable Object simulator stifinder was extracted from does exactly that,
with `rpcFail`, `d1Fail`, `crash` and `skipEviction`. **Cost.** Costs are
partially ordered, so a state has no single best cost. What is kept per
state is a Pareto frontier of arrivals (D13), and every comparison of costs
walks their keys. DESIGN.md §3.

### D31. Steps are a cost key, counted for every event

Every edge costs one `__steps__`, in the same vector as the model's own
keys and `__deviations__`. It is always counted; there is no opting out.

**Why.** The maintainer's decision, 2026-09-30, out of the argument in D10.
Three things follow from the one change. A budget can bound the length of a
run, so a long or endless baseline no longer has to be walked to its end
before one deviation is tried. The cache holds the trade between steps and
everything else: a state reached in fewer steps by more deviations is an
arrival of its own, so "the fewest deviations within ten steps" is a
projection of what is already there. And a run is bounded without the model
returning `[]` after so many steps, which made every cut-off an end that
`terminalInvariant` had to expect (D7). The search also lost a concept:
depth was a field carried beside the cost, with an argument from the order
of exploration that the first arrival was the shallowest (D12).

**Rejected:**

- *Depth as a field beside the cost*, the earlier form. Dominance ignored
  it, so a shorter way to a state already reached more cheaply was
  discarded at that state, and with it every violation it led to. On a
  baseline of 40 steps to a failing state, with a one-deviation shortcut to
  it, one error edge was recorded, and the two-step violation was unknown
  to the cache at any budget. Test: `steps: the length of a run is a cost`
  › "a shorter way by more deviations is an arrival of its own, beside the
  cheaper and longer one".
- *Reporting the shortest violation of each deviation budget from the error
  edges already held*, proposed in the same discussion. For the reason just
  given, the cache did not hold them.
- *A key the model lists on every event.* It works, and is how the idea was
  first measured, but the ranking then counts steps among the model's other
  cost (D10).
- *Opting in.* Not per budget: a step budget is sound only if dominance
  counts steps, since a kept cache may hold a cheaper arrival beyond the
  current step allowance. Per cache it would keep two searches, and the
  oracle would have to cover both.

**Evidence.** The oracle (D25) has steps in its costs and bounds them in
half its budgets. Ten one-line bugs seeded into the change, among them
dominance ignoring steps, a step budget dropping edges where it should
defer them, and steps counted among the other cost, each fail it. 160,000
random models pass.

**Cost.** Not one `applyEvent` call more; the cost is in what the cache
keeps and walks. Against the search before it:

| Model | Arrivals | Time |
| --- | --- | --- |
| dining philosophers, 7, explored to exhaustion | 1,775 → 3,101 | 25 → 33 ms |
| dining philosophers, 8, explored to exhaustion | 4,922 → 8,566 | 70 → 102 ms |
| a 50,000-step run, one deviation | unchanged | 404 → 606 ms |
| a decision tree 14 deep, no state reached twice | unchanged | 95 → 107 ms |

Where states merge there are more arrivals to record and to traverse;
where they do not, each edge still makes a cost vector of its own. A run is
exhaustive a deviation budget later (D17). `violation.cost` and `costs`
carry the key, which breaks a caller that compares them whole: released as
D24 says. DESIGN.md §3.

### D32. A budget bounds the keys it names; a missing allowance is no limit

`{}` allows everything. `{ crash: 1 }` allows one crash, and any amount of
anything else, deviations and steps included.

**Why.** The maintainer's decision, 2026-09-30. Steps (D31) had to default
to no limit, or every budget written before them would have explored
nothing. One rule for every key was chosen over an exception for one: a
budget says what it bounds. **Rejected:** zero as the default, the earlier
rule, with `__steps__` alone unlimited when missing. **Cost.** What a
budget means has changed, which is breaking. `explore(cache, {})` explored
the baseline with none of any key, and now explores everything.
`exploreIteratively` without a `baseBudget` allowed none of the model's
keys, and now allows any amount. And a key misspelt in a budget bounds
nothing, silently, where it used to leave the real key at zero. Cost and
budget read a missing key differently, zero and no limit, so they are
compared by two functions. Test: `budgets and deviations` › "a key a budget
leaves out is not limited: the empty budget allows everything". DESIGN.md
§3.2.

### D5. A model says what is wrong in three places (#12, #13)

`applyEvent` returns `{ error }` for a failure while doing something.
`invariant` rejects a state that is wrong in itself. `terminalInvariant`
rejects a state that is wrong to end in. A failed check is recorded as an
error on the edge into the state, carrying the state as `badState`.

**Why.** Before `invariant`, a wrong state had to be smuggled into
`applyEvent` by computing the successor and then rejecting it. Then the
initial state was never checked, the check ran once per edge into a state
instead of once per state, and the violation could not show the state,
since an error had been returned in place of it. Before
`terminalInvariant`, a model could only tell an end by working out for
itself whether anything could still happen, which is `getEvents` over
again. Recording a failed check as an error edge meant ordering, budgets,
`analyzeCache` and `shortestViolation` needed no new cases: the shortest
violation is reported whichever kind it is. **Rejected:** built-in deadlock
detection. "No events and not finished" needs the model to say what
finished means, and `terminalInvariant` lets it. DESIGN.md §2.4.

### D6. Two checks, not a `terminal` flag on one (#13)

**Why.** Whether a state is terminal is known only once `getEvents` has run
on it, so a flag would put `getEvents` before `invariant` for every state,
including those the invariant rejects. The invariant guards `getEvents`:
asking a broken state for its events may be meaningless. The order is
`invariant`, then `getEvents`, then, if that was empty,
`terminalInvariant`; a test pins the call sequence. **Cost.** None when
`terminalInvariant` is absent. When it is present, `getEvents` for a
successor moves forward to the moment the edge into it is applied. It is
the same kept call the search would make anyway, so each state is still
asked once. DESIGN.md §2.4.

### D7. Terminal is a property of the model, not of a budget (#13)

A state is terminal when `getEvents` returns `[]`. A state whose events are
all beyond the budget is not, and is not shown to `terminalInvariant`. A
model that bounds its runs by returning `[]` after so many steps makes
those cut-offs ends, and its `terminalInvariant` has to expect them; a
`__steps__` allowance bounds them without making ends (D31).

**Why.** The check's result is kept per state (D1), and an end that
depended on the budget could not be. **Rejected:** checking the states a
run is stuck in under its budget, those with no affordable event. The
simulator's tests did this by hand, for "with at most one crash, no run
ends unresolved". It is the wrong test, because
being out of budget is a property of a run, not of a state: a state reached
cheaply by one path and dearly by another has an affordable event, so it is
passed over, though the dear run is stranded there. With more budget, fewer
such states are caught. What the property needs is that a fault is
optional, so a state where only faults remain is a place a run can end at
any budget, and that is a fact about the model. Hence the rule: **a fault
is offered beside a free event, never as a state's only event.** Then
declining the fault is a step, and where it leads is terminal. Test:
`terminalInvariant` › "nor is a state whose only event is a fault, at any
budget: a fault goes beside a free event". **Cost.** A model that offers a
fault alone gets no check there and no warning. A flag for it is under
Open. DESIGN.md §2.5.

### D8. `badState` is the cache's to add (#16)

`ApplyResult` is `{ to } | { error }`. The cache adds `badState` when a
state fails a check, and drops one that `applyEvent` returns.

**Why.** `badState` reports a state that failed `invariant` or
`terminalInvariant`; an error from `applyEvent` has no state. The type
alone cannot keep one out, because TypeScript does not check an arrow
function's returned literal for extra properties, so the cache drops it at
run time. DESIGN.md §2.4.

### D9. A model is light to write (#11)

`cost` may be omitted. A callback may return its result or a promise of it.
`exploreIteratively` takes a model directly, or a cache to keep. The type
is `Model`.

**Why.** Writing the dining philosophers example showed where the API made
a caller work: the README's opening example lost its cache, its two
`async`s and four `cost: []`s. Callbacks were already awaited, so accepting
synchronous ones changed only types. **Cost.** Every callback result is
awaited, synchronous or not. kilde's experiment of 2026-09-13, against
0.0.1, measured about 5 µs of fixed cost per edge (interning, the cache
lookup, the frontier update and two promise hops) against 1 µs per run for
a depth-first loop: twice the time on its real suite, where a test body
costs 30 µs.

## The search

### D10. "Shortest" is lexicographic: deviations, then other cost, then steps

The violation reported is the one with the fewest deviations; among those,
the smallest sum of the model's own cost keys; among those, the fewest
steps.

**Why.** Fewest deviations first is the point of the library: the failure
that strays least from the expected schedule is the least surprising one,
and the counterexample a reader wants. A failure with no deviation happens
on every normal run, and what describes a trace is its deviations, not its
default steps. It is also the order the search can afford. **Rejected:**
fewest steps first, argued on 2026-09-30. It is often the better trace to
debug: where the preference order is arbitrary, where the default prefix is
long, and where both kinds of violation exist and only the first is
reported. But as a search order it is depth bounding, whose cost is *C^d*
for *C* choices at depth *d*, and deep errors stay out of reach (the
delay-bounding paper's argument against it; in kilde's experiment a bug
twelve decisions deep and two deviations in was found in 115 runs). What
the argument did expose is met otherwise: steps are a cost key (D31), so
the cache holds the trade-off between steps and deviations, and a step
allowance picks the short trace, or keeps a long baseline from standing in
the way. **Not recorded:** why the model's own keys are compared by their
sum, and not key by key. **Cost.** The promise holds for a run that
completed. A run cut short guarantees only the fewest deviations,
since a violation with less other cost may lie where it did not reach; the
README's result table says so (#17). Which violation is reported is API
(D23). DESIGN.md §6.2.

### D11. Which of several tied violations is reported is unspecified (#17)

Of violations equal in deviations, other cost and steps, the one reported
follows the order of exploration. `analysis.violation` and
`shortestViolation(analysis)` agree on rank, and may pick different ones.

**Why.** The order of exploration is free to change (D23), and promising a
particular violation among equals would make it API. **Rejected:** the
earlier documentation, which said the two searches agree. They did not on
ties, and CONTRIBUTING's rule that the reported violation is API conflicted
with the order of exploration being free. Test: `regressions` › "of
violations that tie, either may be reported, and the two searches may
differ". DESIGN.md §6.2.

### D12. Deviation levels in ascending order, and each level's steps in turn (#17)

Pending edges are kept by the successor's deviations, then by its steps. A
call drains the levels from the lowest, and each level from the fewest
steps, stepping a cursor.

**Why.** Traversing an edge at level *d* queues edges at level *d* or
higher, one step further, so lower levels are never refilled, and a call
with *d* deviations touches nothing above them: that is what makes
deepening cost only what is new. Until steps became a cost key (D31) the
order also carried the promise of the shortest path, the first arrival at a
(state, cost) pair being the shallowest; now a longer way at the same cost
is simply dominated. **Rejected:** searching a level for its lowest depth
each time, the earlier form. It is quadratic in the depth of a level, and a
long run with an alternative at every step, the usual shape of a
simulation, fills one level with a depth per step: a 50,000-step run took
2.6 s and took 185 ms after. The cursor relies on a level only growing
deeper within a call; if that were ever broken, the loop throws an internal
error instead of spinning. DESIGN.md §5.

### D13. Arrivals are kept per (state, cost); a dominated one is not recorded, and a recorded one is never removed

A new arrival at a cost that is at least one already recorded for its state
is skipped. An arrival already recorded stays, even once a cheaper one
dominates it. Pareto pruning happens when the cache is projected onto a
budget.

**Why.** A dominated arrival adds nothing: every path on from it exists
from the cheaper one, at no more cost. Keeping recorded arrivals keeps
their predecessors stable, and paths are rebuilt from predecessors.
**Cost.** `reached` can hold arrivals that the projection discards, and the
projection compares each state's arrivals pairwise. With steps among the
keys (D31) a state has an arrival for each trade of steps against the
rest, where it used to have one per cost. DESIGN.md §3.3, §6.1.

### D14. An unaffordable edge is deferred, not dropped, and an unbounded budget ends where the levels do (#15)

An edge beyond the budget in a key other than deviations, steps included,
moves to `deferred`, and every later call re-checks it against its own
budget. A call visits only the deviation levels that have edges.

**Why.** The cache is independent of budgets (D16), so an edge one call
cannot afford must still be there for a richer one. Test: `regressions` ›
"reusing a cache across non-monotone budgets does not lose deferred edges".
**Rejected:** stepping through the levels one by one up to the budget's.
With `{ __deviations__: Infinity }` that never ended, and never reached a
deadline check, so `timeoutMs` did not stop it. DESIGN.md §5.

### D15. `shortestViolation` prunes by dominance (#17)

The search over the transition table skips a (state, cost) pair reached at
a cost no lower than one already seen for its state.

**Why.** Whatever follows the pair follows the cheaper one too, and ranks
strictly better there, so the result is the same. And the search ends at
any budget: with finitely many cost keys, a sequence of costs in which none
is at least an earlier one is finite (Dickson's lemma). **Rejected:**
searching without pruning. With an unbounded deviation budget and a cycle
that costs a deviation it never ended, and since #15 `exploreOnce` hands
such an analysis back. DESIGN.md §6.3.

## The cache and its results

### D16. One budget-independent cache per model, and one search on it at a time

A `StateSpaceCache` owns its model. `explore` fills it as a side effect and
returns statistics; `analyzeCache` projects it onto a budget.
`exploreIteratively` and `exploreOnce` are built from those two.

**Why.** A richer budget can only enable more transitions, never invalidate
one, so nothing stored needs a budget attached, and one cache serves
budgets in any order. Owning the model means a cache cannot be mixed with
another model's results. A second `explore` on a cache while one is in
flight is rejected: both would drain the same queues. DESIGN.md §4.

### D17. Every result says whether it is exhaustive, for its own budget (#11, #15)

`exhaustive` is true when no edge is left at any budget and everything the
cache holds is within the budget of the call.

**Why.** `completed: true, violation: null` reads like a proof and is not
one: a run capped at one deviation reports exactly that about a failure two
deviations deep. Telling the two apart meant inspecting the cache's queues
by hand. **Rejected:** the first form, which reported the cache's own
exhaustiveness. On a cache explored earlier at a larger budget, a second
`exploreIteratively` stopped at budget 0 with `violation: null, exhaustive:
true`, although the first run had found a violation. The cache now keeps
the componentwise maximum of every cost it records, and a result is
exhaustive only when its budget covers that. `cache.exhaustive` keeps its
meaning: the cache holds everything, explored at whatever budgets.
**Cost.** Everything is every arrival, so since D31 a run is exhaustive
only once the shorter, dearer ways to known states are explored too. On the
dining philosophers that is one deviation budget later than before, with
no `applyEvent` call in it. Tests: `exhaustive: what a result without a
violation proves`. DESIGN.md §8.

### D18. However a call ends, the cache is consistent (#15)

A call that returns, hits a limit or rejects leaves every untraversed edge
queued. After a throw, the next call meets the same throw.

**Why.** A cache is kept across calls, so what one call leaves behind is
the next call's premise. **Rejected:** the earlier order, which recorded an
arrival before asking for its events and took a bucket of edges out of
`pending` before traversing it. When `getEvents` threw, or valsem could not
intern a state, the arrival was recorded but never expanded and the rest of
the bucket was gone; the next call could complete with `exhaustive: true`
without exploring what was lost. Now whatever can throw comes before an
arrival is recorded, and a `finally` puts untraversed edges back. Tests: `a
callback that throws`. DESIGN.md §5.

### D19. Iterative deepening stops where no larger deviation budget could find more (#15)

`exploreIteratively` stops short of `maxDeviations` at a violation, or once
nothing is pending, nothing in the cache took more deviations than the
current budget, and every deferred edge needs more than `baseBudget`.

**Why.** Further iterations would find nothing, and with `maxDeviations:
Infinity` there would be no end to them. **Rejected:** stopping as soon as
the cache was exhausted, which gave the false proof of D17 on a kept cache;
and running on to `maxDeviations`, which hung at `Infinity` once the only
edges left needed more of the base budget. **Cost.** For a run that only a
larger `baseBudget` could take further, `maxDeviationsReached` is where it
stopped, not `maxDeviations`. DESIGN.md §7.

### D33. `exploreIteratively` deepens deviations only

A bound on steps, or on any other key, is an allowance in `baseBudget`.
Each deviation budget is explored within it.

**Why.** The maintainer's decision, 2026-09-30: the key first (D31), a
policy later. The cache makes any sequence of budgets cheap, so deepening
along two keys is a loop a caller can write on `explore`, and which such
loop deserves to be built in is not known yet. **Cost.** A result within a
step allowance has cleared two bounds, of which one was deepened: "no
violation within 50 steps and 3 deviations". Test: `steps: the length of a
run is a cost` › "deepening within a step allowance tries a deviation
before the baseline is walked to its end". DESIGN.md §7.

### D20. A violation carries its whole cost, and each step its index (#9)

`ViolationPath.cost` is the cost of the whole path, the failing event
included, and so its `__steps__` is the number of steps.
`ViolationStep.index` is the event's position in `getEvents`.

**Why.** A step's `cost` is the cost before it, so the charge for the
failing event, often the deviation that matters, appeared nowhere, and a
step did not say whether it was the baseline or a deviation. A caller
printing a trace had to read the deviation count off the budget that
happened to fail and recover the deviating steps by differencing
neighbouring costs. The index is recorded when the edge is queued:
**rejected** was looking the event up in `getEvents(state)` afterwards,
which is ambiguous for an event listed twice. Test: `regressions` › "an
event listed twice is reported at the index it was taken at". DESIGN.md
§6.2.

### D21. Budgets and limits are checked (#17)

An allowance, `maxEdges` and `timeoutMs` must be a number, zero or more;
`maxDeviations` must also be whole. Anything else is a `RangeError`.
`Infinity` says no limit, as leaving a key out of a budget does (D32).

**Why.** `maxEdges: NaN` was no cap at all, and `NaN` is what
`Number(process.env.X)` gives with X unset. `NaN` for a cost key was an
unlimited allowance, but for `__deviations__` it was zero, and
`maxDeviations: -1` still explored budget 0. A limit that cannot be read is
an error, not a limit read some other way. DESIGN.md §3.2.

An option given as `undefined` is one left out, and every optional field
of an options object, a descriptor or an alternative says so in its type
(`maxEdges?: number | undefined`). **Why.** A wrapper passes its own
optional options straight through, `{ maxEdges: options.maxEdges }`, and
under `exactOptionalPropertyTypes` a type that only omits the key rejects
that, though the runtime has always read `undefined` as the default. kilde's
wrapper is written that way, and compiled only because kilde does not set
the flag (found by the external review of 0.2.0, 2026-10-03). Test: `check`
› "an option given as undefined is the default, as one left out is".

## API surface and verification

### D22. A cache's working state is internal (#16)

A cache's API is its `model`, the canonical `initialState`, `exhaustive`,
`statesExplored` and the read-only counters. What it stores, the methods
behind it and the types of its entries are `@internal`, and `stripInternal`
leaves them out of the published declarations.

**Why.** Everything exported is API, so while the working state was
exported, any change to how the search stores things was a breaking change.
**Evidence.** The suite compiles against `src/`, where the internals exist,
so it cannot see the published types. A scratch consumer compiled against
`dist/index.d.ts` used the whole public surface and put `@ts-expect-error`
on each internal member, on an assignment to a counter, and on a `badState`
in an `ApplyResult`; against the declarations before the change every one
of those lines failed. DESIGN.md §1.2, §4.

### D23. Which violation is reported, and how cost is counted, are API; the order of exploration is not

Breaking: changing which violation is reported for a model and budget, up
to ties (D11), or what charges a deviation and how cost keys add up. Free
to change: the order in which states are explored beyond what the reported
violation depends on, and so the number of edges a search computes; the
text of error messages; performance. CONTRIBUTING.md has the full list.

**Why.** A user's test asserts the violation and its cost, so those must
hold across releases. The search has to stay free to store and order things
differently, which is also why its working state is internal (D22).

### D24. Before 1.0, a rename keeps the old name, and a breaking release is forced to a minor (#11, #16)

`ExplorerConfig` and `cache.config` remain as deprecated aliases of `Model`
and `cache.model`. The one breaking change so far (D22, D8) was released as
0.1.0 with `Release-As` in the pull request's override block.

**Why.** release-please is configured without `bump-minor-pre-major`, so a
`feat!` would release 1.0.0. Additive changes avoid that; where a break is
wanted, the version is forced.

### D25. The search is checked against a brute-force oracle on random models (#15, #17)

`src/oracle.test.ts` compares every search against a breadth-first search
over (state, cost) pairs with no cache, levels, deferral or dominance, on
seeded random models, after random histories of calls on one cache.

**Why.** The search's mechanisms interact, and its bugs are silent: a false
proof, or a violation that is not the shortest. The review that found such
bugs found them with one-off scripts; the oracle keeps them found.
**Evidence.** On the code before #15 it hangs at its first unbounded
budget, and with those taken out it fails three of its four properties.
Given eight deliberate one-line bugs in the search, from taking depths
deepest-first to not putting interrupted edges back, it fails on every one.
400,000 models passed at #15, and 160,000 at #17 on the strengthened test,
which also checks `shortestViolation`. **Cost.** About 100 ms for 300
models per property; more on request (`FUZZ_RUNS`). DESIGN.md §10.

### D26. valsem is a peer dependency, its range one minor wide, and CI tests its floor (#18, #26)

The peer range is `>=0.2.0 <0.3`. A CI job installs the lowest version the
range admits, read from `package.json`, and runs the typecheck and the
tests against it.

**Why.** The cache keys by structural equality, so it must share one valsem
instance with the model's state and event types. A floor that is declared
and not tested is a guess. Before 1.0, valsem releases a breaking change as
a new minor: 0.1.0 renamed the edits stifinder makes (`set`, `delete` and
`push` on a value are `with`, `deleted` and `pushed`), and none of 0.0.x
has the new names. So the floor moved to 0.1.0, and the range ends before
the next minor, which may break stifinder in the same way. 0.2.0 did not:
it changed the protocol a value class implements (`[hash](hasher)`), which
stifinder has none of, and made a second copy of valsem a separate library
whose values are refused, which is what the peer range exists to prevent;
the floor moved to 0.2.0 with nothing else to change but a comment, and the
range ends before 0.3 as before. **Rejected:**
`<1`, the range until #26: it admitted every later minor of valsem
untested. **Cost.** Each valsem minor needs a stifinder release that widens
the range, and raising the floor is a breaking change (CONTRIBUTING.md).
Whether the job is a required check is under Open.

## Testing real code

Settled in the design discussion of 2026-09-30, from two users of
stifinder: kilde's `kilde/testing`, and the Durable Object simulator
stifinder was extracted from. D28 and D34 to D37 are built. The rest is
not: see Open.

### D27. stifinder owns the test-facing layer; simulators stay with their systems

Running a search as a test, rendering a violation, re-running the failing
path, asking questions of the explored space, and exploring a body of code
that asks for its decisions belong in stifinder. A simulator of a
particular system does not.

**Why.** Both users wrote that layer for themselves. kilde's adapter is 232
lines that import nothing from kilde but the type of its decision oracle.
The simulator's harness has its own `exploreTest`, event and state
formatters, a traced re-run of the failing path, and an assertion over
reachable states with the path to a witness. **Rejected:** a simulator, or
a snapshot-and-restore framework for one, in stifinder. The Durable Object
simulator is about 2,000 lines of Cloudflare semantics (sessions, replay of
per-object event logs to re-park handlers, database ops, message fates),
and to stifinder it is a `Model`. **Left out until something uses it:** a
task scheduler over the decision oracle; the two that exist have no user
but a self-test.

### D28. Names are asked of the model when a report is rendered

A model may have `describeEvent(event, state)`, how an event reads at the
state it is taken at, and `describeState(state)`. A search calls neither;
`formatViolation` calls them for the steps of the one path it renders.

**Why.** In the simulator an event is named from the state it is taken at:
its indices are resolved against the pre-state's in-flight requests. A
state summary parses database snapshots. Both make sense only for the few
states of a reported path. **Rejected:** a `label` on `EventDescriptor`,
stored with the event list, the first recommendation in the discussion. It
builds a string for every event offered on every edge of a search that
reports at most one path, and state summaries would need a lazy form
anyway. The decision harness keeps its labels in a table of its own and
answers from that. **Cost.** A describer is outside the purity a model
owes its callbacks (D1), and may fail on its own account. So one that
throws is treated as one that says nothing, and the value is shown as it
is: reporting a failure must not hide it. DESIGN.md §2.2, §9.2.

### D34. `check` rejects on a violation, and on a search cut short

`check` resolves with the result only when the search found nothing and
was not stopped by `maxEdges` or `timeoutMs`. A violation rejects with a
`ViolationError`, a search cut short with an `IncompleteError`, unless
`incomplete: 'allow'`.

**Why.** Both users wrapped `exploreIteratively` in a function that turns a
result into a verdict, and differed on the case that matters. kilde's
rejects when the search did not complete. The simulator's logs a timeout
and returns, and none of its tests asserts `completed`: a search stopped by
the timeout, or by the 100,000-edge default, passes there with `violation:
null`. A test that passes should mean the search looked at what it was
asked to. **Rejected:** resolving with `completed: false` and leaving the
test to assert it, which is the form that was not asserted. **Rejected:**
resolving only when `exhaustive`. A search bounded on purpose, by
`maxDeviations` or a step allowance, is a test worth having; whether it is
a proof is the test's to assert on the result (D17). **Cost.** A test of a
space too large to finish has to say so, with `incomplete: 'allow'`. A
violation found by a search that was cut short is thrown like any other,
though it is only the fewest deviations it guarantees (D10). Tests:
`check`. DESIGN.md §9.1.

Both errors carry the result of the search as `space`, the `StateSpace`
that `check` would otherwise have resolved with. **Why.** A wrapper that
reports what a search did, kilde's `exploreTest` with its runs, states and
edges, had the result only when the search passed, and nothing when it
failed, which is when the numbers are wanted (found by the external review
of 0.2.0, 2026-10-03). `IncompleteError` had carried three of its fields
already; those stay. **Cost.** vitest serialises every own property of an
error across its worker boundary, `costs` and `transitions` included:
measured at about 150 ms more per failure for a space of 16,000 states,
beside the 150 ms the search took. Its report prints only the message, the
stack and the cause, so nothing is added to what a failure shows. A
`ViolationError` made by hand has no space, and says so in its type. Test:
`check` › "either error carries the result of the search, as check would
have resolved with it".

### D35. A report lists every step, in the model's words, with what each was charged

`formatViolation` gives the error first, then the cost of the path, then
one line per step, then the state that failed. Its text is not API. A model
may say how it is to be rendered, with `report`, and a caller's options
come over that.

**Why.** Each user had written this by hand: the dining philosophers
example, kilde's list of deviations, the simulator's trace. The error comes
first because a test runner's summary is the first line of a message. A
step shows what it was charged, a deviation or a cost key of the model's,
because that is where the budget went, and a reader would otherwise find it
by differencing the costs of neighbouring steps (D20). The wording is left
free, as the text of an error message already is (D23). **Evidence.** The
example's own report was a dozen lines of formatting and is two
describers; its output, which the README quotes, is the library's.
**Rejected:** the view of a report as a property of the call, the first
form: `check(body)` rendered the charged steps alone and
`check(decisionModel(body))` every step, for one model, and the docs had
to say so. An external review of 2026-09-30 put the default where the
model is (a body's expected steps have no words of their own, which is a
fact about the model), so that a violation reads the same however it is
rendered. The same review renamed the view from `'deviations'` to
`'charged'`: a first alternative may list a cost key, and the view keeps
that step too. **Cost.** Every step is a line, so a long path is a long
message. Tests: `formatViolation`, and "the model asks for the charged
steps alone in its report". DESIGN.md §9.2.

### D36. A body is explored through its decisions: the state is the decisions so far, and one run harvests a chain

`decisionModel(body, options?)` is the move of kilde's adapter. A state is
the picks made so far, an event the next pick, and a run of the body with a
state's picks replayed and 0 answered after them records every state along
that default continuation. A run's failure is reported by `invariant` on
the state it reached, a promise the body returns is awaited, and a run is
cut off past `maxDecisions`, 10,000 by default, which is a violation on the
state the run was for.

**Why.** JavaScript cannot capture a continuation, so a body can only be
put back into a state by running it there again, and the decisions it made
are what it takes to do that. Recording the whole default continuation of a
run means the body runs once per leaf of its decision tree, which is
exactly the count of a depth-first enumeration: kilde's experiment of
2026-09-13 measured the same 2,287 runs on its suite of 92 tests under
both, and twice the time, from about 5 µs of search per edge against a body
of 30 µs. **Rejected:** stopping a run at the first decision it has no
answer for, which runs the body once per edge instead. **Rejected:** kilde's
two ways of reporting a failure, both defects. It reported a run's error on
the edge into the state the run reached, so a body that throws before its
first decision, which reaches only the initial state, passed as exhaustive;
seven of kilde's own tests give it an empty source, and the one of them
checked consults no decision, so its assertions cannot fail. And it did not
await a body's promise, so an async body's rejection escaped
as unhandled and the body passed. `invariant` covers the initial state
(D5), and awaiting is what the callbacks already do (D9). Tests: `a body of
code, explored through its decisions` › "a body that throws before its
first decision fails at the initial state", "a body that returns a promise
is awaited, and its rejection is its failure". **Cost.** No state is
reached twice, so the cache's sharing of states does nothing here, and the
space is the tree of decision sequences, exponential in their length; a
step allowance bounds it (D31). The body must be deterministic, and is told
nothing of the search: the harness checks what it can, that a replayed
decision has the alternatives it had, and that a run makes the decisions it
replays. No limit of the search can interrupt a run, since a run is one
call of one callback, so a body that keeps deciding would hang the search;
`maxDecisions` is what cuts it off (found in the external review of
2026-09-30), and a run that loops or waits without deciding is beyond any
limit. **Rejected:** the cut-off as a `DecisionsError`, the first form. A
run that does not end under its schedule is a fact about the body: after a
deviation it is a livelock the search has found, and reported as "the test
is wrong" it came with no path to it (an independent review, the same
day). It is a violation on the state the run was for, so the path is the
prefix and not ten thousand zeros, and `runOnce` replays it. A state is a
valsem `ValueList` of the picks, so a decision more is a push and a state
hashes and compares in O(1). **Rejected:** a plain array, the first form.
Each state along a run was a copy of the one before, and interned whole by
the search and hashed whole by the model's table, so a run of n decisions
cost O(n²): one run at the default cap took 2.2 s, 4.6 s on CI, where the
test of the cap timed out (found when the release PR for 0.2.0 failed,
2026-10-01), and takes 67 ms as a list. Test: "a long run costs what its
decisions do, not their square". A state is a value the caller
cannot look into (`DecisionState`), which leaves its form free: merging
states by a fingerprint of the world at a decision, if a body can give one,
is under Open; `decisionsOf` gives the decisions of a violation from its steps'
events, which stay the picks whatever a state becomes. `describeState`
renders a run of more than three equal picks as one, `0 ×6999`: the first
form listed every pick, which made the "in state" line of a run near the
cap some 30 KB, under a report whose point is to list the charged steps
alone (found by the external review of 0.2.0, 2026-10-03); `decisionsOf`
is the form a program wants, and the text is for people (D35). Test: "a
run of more than three equal picks reads as one". DESIGN.md §9.3.

### D37. `Decisions` is `maybe`, `choose` and kilde's `integer`; its errors are never the body's failure

A decision is `maybe(label, { cost })`, whether something unexpected
happens; `choose(alternatives)`, each alternative a value with a label and
cost keys; or `integer(range, label?)`, a number below `range`. A wrong use
of any, a body that is not deterministic, or a decision made once the run
is over is a `DecisionsError`, with which the search rejects. A body is
checked as `check(decisionModel(body))`; `check` takes no body.

**Why.** An alternative maps one to one onto an `EventDescriptor`: its
position is the index, and so the deviation, and its keys are the event's
cost. That gives a body the fault budgets a model has (D4): "at most one
lost send". `maybe` is the common case, a fault with a cost key, in one
call; `choose` any other, with `const` inference so that the value comes
back as the union of the alternatives' values. `integer(range, label)`
keeps the signature of kilde's oracle, so its test doubles, which take an
`{ oracle }` with that one method, work against a `Decisions` unchanged.
The report of a body lists the charged steps alone (D35), and
`decisionsOf(error)` gives the decisions, which `runOnce(model, error)`
takes to run the failure again under a debugger; kilde printed them, and
offered no way to replay. `runOnce` takes the model as well as the body,
and runs the body under the model's `maxDecisions`: given the body alone,
a failure that a search with a larger cap had found past the default one
was cut off on replay (the review of 0.2.0). The model shows its `body`
and `maxDecisions` for that. **Rejected:** a `runOnce` method on the
model, which would make the model two things; the free function beside
`decisionsOf` is the form the README teaches. Test: "given the model, runs
its body with the cap it was built with".

A `DecisionsError` is the test being wrong, not the code under it, and a
violation would say the opposite. It says which run's decisions it happened
at, since the harness knows them and the user otherwise could not find the
run. It escapes the search by way of
`getEvents`, the one callback whose throw the search does not take for an
error of the model: the run keeps the first such error, throws it again at
every later decision, and records it on the state once the body is done,
whatever the body did with it; `invariant` reports nothing for that state,
and `getEvents`, called on it right after, throws. That asymmetry between
`getEvents` and the other callbacks is now load-bearing, so it is stated in
`getEvents`'s doc and the README, and pinned by a test in the search suite
("is an error of the model from applyEvent and the checks, and the failure
of the search from getEvents"). A decision made once the run is over, from
work the body left running, is thrown to that work and remembered by the
model, which throws it at the next state a search asks the model about: the
one way left to misuse `Decisions` without being told, which the review's
second round found. That next state is the next search's. A run is complete
on the microtask queue, and a search is one chain of runs, so a timer a
body sets fires only once the search is over, whatever the size of the
search (4,096 runs each leaving a `setTimeout(…, 0)`: none fired before
`check` resolved); the search a decision was late for resolves, and only a
later search of the model rejects. The first form of this entry said the
search would be told "at its next step", with a kept cache that holds
everything as the one exception, and the external review of 0.2.0
(2026-10-03) read that as a false proof. It is not one the search can
close: a timer is not a thing a body sets but a thing it models, as a
decision of a double today and through a host in the proposal under Open,
and a body that sets one has left the model, as one that reads a clock has
(D1). What the search can say is the rule, and it does, in the README and
DESIGN.md §9.3, in place of a claim that was not true. **Rejected:** a
hook on `Model`, awaited once a search is over, under which the body's
model took one turn of the event loop and threw what had decided within it
(the first form of PR #28, after the review's suggestion). It would catch
a `setTimeout` of 0 and not one of 100 ms, and so bless the rest; it
treated a body outside the model as something the search should tolerate;
and it put a member on `Model`, and a guard against faked timers, for
that accommodation alone. **Rejected:** throwing the late error from a
fresh macrotask as well, so that it is an unhandled error whatever the late
work does with it: a process-wide side effect of the kind D29 keeps out,
for the same body that has left the model. Test: "a decision made once
the body is done is thrown to the work that made it, and to the next
search of the model". The body is
called through an async function, so that one that throws before returning
takes the tick one that returns does, and the microtasks it queued fall on
the same side of the run's end either way (the independent review).
`runOnce` has the same cap as a search, since a debugging helper that hangs
is worse than one that errors. **Rejected:** `integer(range, label, { cost
})`, so that kilde's doubles could charge a fault key. For two alternatives
it is `maybe`; above two, every deviation charging the same keys is the
narrow case `choose` already covers with keys of its own per alternative.

**Rejected:** `check(body)`, an overload on `typeof subject === 'function'`,
the first form. A zero-argument function that returns a model type-checks
as a body, since a body may return anything; `check(makeModel)` for
`check(makeModel())` then ran the factory as a body that decides nothing,
and passed as exhaustive. The harness also needs options of its own
(`maxDecisions`, `report`), which belong on `decisionModel`, not on
`check`. **Rejected:** throwing a misuse through the body and no further,
the first form. Every run happens inside `invariant`, whose throw the cache
records as `{ error }`; so a misuse came out as a `ViolationError` with a
path, a body that caught it hid it, and a test pinned that as intended.
Both were found in the external review of 2026-09-30. **Cost.** A label
for `integer` and `maybe` says what a pick other than 0 means, as kilde's
did, so a full report reads "the send fails: no" for the expected pick;
`choose` names every alternative. Tests: `a DecisionsError is the test
being wrong, and never a violation`. DESIGN.md §9.3.

A single alternative is no decision, as a range of 1 is, unless it lists a
cost: then it is a step that charges it. The first form returned it
without a decision whatever it listed, so a lone `{ cost: ['crash'] }`
charged nothing and a budget of no crashes let the run through it (found
by the external review of 0.2.0, 2026-10-03). A lone alternative is what a
list built from the system's state comes to when that state offers one
thing, and the budget must hold for it as for two. Test: "a single
alternative that lists a cost is a step that charges it".

### D29. Notes reach the recorder through an argument

`applyEvent` receives a third argument through which a model records what
happened inside a step. It records on a traced re-run of a reported path,
and is a no-op during a search.

**Why.** The maintainer's choice, over the alternative below: nothing
global, and a callback that ignores the argument still type-checks.
**Rejected:** a module-level `note()` that does nothing unless a recording
is active, as the simulator's `trace()` is. It is reachable from any depth
without plumbing, but it is global state: two copies of the package, or
two searches in one process, would cross. **Cost.** A simulator threads the
argument to where its notes are made.

### D30. One entry point

Everything is exported from `stifinder`. Behind it the source is modules,
the search, the report, `check` and the decisions, which the entry point
exports whole.

**Why.** stifinder is a testing tool throughout, and the harness adds no
dependency. The test entry takes a model, a cache or a body, so the root
would import the harness anyway. **Rejected:** a `stifinder/testing`
subpath, by analogy with `kilde/testing`. kilde's root is a production
library and its testing helpers need an optional peer, which the subpath
keeps out of production imports. Neither holds here.

## Non-goals

A simulator of any particular system, or a framework for writing one
(D27). Built-in deadlock detection (D5). A promise about which of several
tied violations is reported (D11).

## Open

**Decided, not built.** The recorder argument (D29), for hand-written
models and value parts; a program part's host records for it (the
proposal).

**Proposed, not decided.** The surface sketched in the discussion of D27;
every name is provisional.

- `explain`, which re-applies each step of a path with the recorder on and
  says whether the path reproduced, and a report that shows its notes.
- `findPath(cache, where)`: the shortest path to a state that satisfies a
  predicate, for "no state where" and for "some state where". From the
  cache, which holds every arrival with its predecessor (D31). The
  proposal's `reachable` is its first use.
- A scheduler over `Decisions` for bodies with several tasks, which picks
  the task to run next and settles between picks. The two that exist have
  no user but a self-test (D27). Subsumed by the proposal's parts, except
  for a body whose doubles decide synchronously, which the first delivery
  leaves on `decisionModel` (see Deferred there).
- `decide.note(text)` on `Decisions`, the body's way to the recorder
  (D29), shown by the report of a failing run.
- Merging the states of a body by a fingerprint of the world at a decision,
  where a body can give one, so that a state reached by two decision
  sequences is explored once (D36). Nothing needs it at kilde's sizes.
  Superseded by the proposal's checkpoints, which fold a part only where
  the system itself restarts from the folded value.
- `settle()`: resolves once the microtask queue has drained. Subsumed by the
  proposal: a step of a system ends when the microtask queue is empty,
  which the simulator waits for, and a body under `decisionModel` is
  complete on the microtask queue by rule (D37).
- An `optional` mark on an event, so that `terminalInvariant` also runs
  where every event is optional, if a fault offered alone should be
  supported (D7).
- A deviation charge the model sets per event: the index, for delay
  bounding without the encoding; zero, for a model with no baseline (D3);
  and a key of its own for a reordering — another expected event taken
  first — which the proposal's expected events make concrete: with one key,
  a budget can say "any schedule, no faults" (the fault keys at 0) but not
  "faults on the plain schedule alone", and whether a bug needs the
  reordering or only the fault is a real question.
- A deepening policy over steps and deviations together, and a result that
  reports the violations that trade one for the other (D33, D10).
- A composition of parts over a simulated network, with a host for the
  code under test: the proposal below. It subsumes the scheduler over
  `Decisions`, `settle()` and `findPath`, and replaces merging by a
  fingerprint with checkpoints that fold a part only where the system
  itself restarts from the folded value.

**Undecided, the maintainer's call.** Whether `test (valsem floor)` becomes
a required check (D26).

**Reasons to record.** Why a deviation is charged whether or not the
index-0 event is affordable (D3); why the model's own cost keys are
compared by their sum (D10). D3's case for the flat charge was argued on
2026-09-30, not recorded when it was built: confirm it or replace it.

### Proposal: composable systems over a simulated network

From the design discussion of 2026-10-03 and 04. Nothing here is built, and
every name is provisional. It is a plan for a first delivery, with the
reasons, what was rejected on the way, and what is deferred and what would
bring it in.

#### What it is for

Testing real code against doubles, with the search exploring what the
doubles decide: a client over a network against a server mock; later
several clients, real servers, Durable Objects. `decisionModel` does this
for one body whose doubles call `Decisions` directly (D36, D37). What it
cannot do is compose: two pieces of real code each with a history of its
own, a network between them with faults of its own, and states that merge
when the pieces cannot tell two histories apart.

#### The model

**A part** is an independent owner of state that evolves by its own
events, and the simulator sees every part through one interface, defined
per *kind*. `initial(id)` is the value a part of the kind starts from.
`events(value)` lists what the part can do next, each a value with a
label, cost keys, and whether the part *expects* it — the sunny-day event,
of which a part may name none or several. `restore(value)` gives a runtime
for a value: the cached runtime if its value matches, else one rebuilt.
`ingest(runtime, event, step)` does one of the events, reaching other
parts through `step`. `snapshot(runtime)` gives the value back.
`describeEvent` and `describeState` are as for a `Model`. A part is a
`Model` with its state split into a value for the cache and a runtime for
the code — and `events` is a function of the value alone, never of the
runtime, which is what lets a system of a thousand parts ask a state for
its events without instantiating one of them. It holds for every part
named here: a host's due queue and pending distances are in its value,
the network's messages in flight and its correlation lists are its value,
a Durable Object's due alarm and queued deliveries are in its value, and a
mock's pending requests are its value.

The runtime is the kind's own, and the simulator never calls it. What it
has is a typed interface for the kinds it talks to — what a host calls to
send a request or abort one, what the network calls to deliver — and a
part reaches a peer by its id, through `step`, which restores the peer if
its runtime is not live and records it as touched, so the touched set of
a step is the calls it made. No part keeps another's runtime: a runtime is
rebuilt on demand, and a reference that outlived one would be stale.

What is a part, and what is smaller: a single request is not one — it has
no runtime, no event but its delivery, and its state is a position in
someone's queue. The grain is the independent owner: a client, a server, a
Durable Object, and the *network* they talk over, one part owning every
message in flight, its deliveries (oldest first, by physics), its losses,
and the correlation between the endpoints' outstanding requests (below).
Why one network and not a channel per link is under Why. Two networks in
one system — HTTP, and Durable Object stubs — are two parts, each owning
the correlation of its own interactions.

**A system** of parts is a `Model`, made from a *registry*: the kinds, and
`kindOf(id)`, which kind an id belongs to. Its state is a `ValueMap` from
part id to snapshot, and so the set of parts is state: a part comes to
exist when a message is first delivered to its id, with `initial(id)` as
its value, and no part is ever removed — a Durable Object's runtime goes
away at eviction, its value does not. Ids are strings: Durable Object ids
are, the network's is the name the test gives it, and a string order is a
part order that no history can disturb (below). Beside the snapshots the
state keeps the *active* set, the ids whose value has any event, so that
asking a state for its events is a walk over the few parts with something
to do, not over every idle object in the namespace.

Its `getEvents` begins with the *candidates*: the events the active parts
expect, in part order and each part's own order; where no part expects
anything, each active part's first event. One candidate is free, at index
0 — the first, or with a `seed` the one the hash of the state picks
(below) — then the other candidates, then every other event in part order
and the part's own order. Part order is declaration order for the parts a
test names, then id order for the parts that came to exist; creation order
would do as well for a reader but not for merging, since two histories
that created the same parts in another order would be two states with
equal snapshots. Its `applyEvent` restores the event's owner, and the
parts a delivery reaches, through the registry — the runtime of a part
exists only once an event is ingested into it or a delivery reaches it —
calls `ingest` on the owner, waits for the microtask queue to drain, and
snapshots the parts the step *touched*: the owner, the parts deliveries
reached, the network outputs went to. Every other part's value is a value
already, and is kept; the active set is updated from the same touched set.
The search core is unchanged, and merging is valsem equality on the
product.

The simulator knows five things, none about time and none about what parts
say to each other: a step ends when the microtask queue is empty;
`restore` touches nothing but its own part; a part's events are a function
of its value; events are values naming things in a snapshot; the
candidates come first, the free one before the others, and part order
breaks the ties that remain. Within a part, order is
physics — a host's due queue runs in the HTML order, a stub's messages are
FIFO, a network of equal latencies delivers oldest first — and a part lists
its events in that order; across parts, order is a choice, and the
candidates are exactly where it is made.

**Three kinds of part** in the first delivery:

- `program(main)`: real code behind a *host*, the adapter it takes its
  platform from: `fetch`, `setTimeout`, `clearTimeout`, `setInterval`,
  `clearInterval`, `timeoutSignal`, and `random` with a `uuid` on it. Its
  value is the log of inputs the host delivered (responses, errors, timer
  firings, the random draws) as a `ValueList`, its
  pending timers as distances to fire, and its queue of due macrotasks.
  `restore` resumes the live runtime when its log matches, else runs `main`
  again with the log replayed: inputs fed back, outputs suppressed and
  compared with the recording, a difference being the test's error, as a
  body whose decisions change is today (D37). It expects the head of its
  due queue; its other events are `advance(δ)`, one per distinct distance
  among its pending timers — its own clock, local and relative, folded into
  the host — and never expected, since time proceeds only when nothing else
  can happen. One `advance` past several wake-ups is one event, and so one
  deviation, where advancing one wake-up at a time is as many: a long stall
  is one fault in the world. The states the two ways reach merge.
- `mock(reducer)`: a value part. Its value is the reducer's state and its
  pending requests, in delivery order. Its events are the outcomes
  `handle(state, request)` returns for the oldest pending request — one, or
  several alternatives each with a label and cost keys, the first expected
  — and taking one removes the request and sends the response into the
  network. A mock with nothing pending has no events. The alternatives are
  the mock's events and not the delivery's, because the delivery is the
  network's event and the network's `events` may read only the network's
  value; so a request costs a step to deliver and a step to answer, and no
  deviation on the expected path.
- `http(routes)`: a value part, the network between the clients and the
  servers; `routes` says which server a URL names. Its value is the
  messages in flight, request legs and response legs, as serialised values
  each naming the position it is about, the correlation lists (below), and
  the orphans of aborted requests. It expects the delivery of the oldest
  message in flight. Its other events are the other deliveries, a lost
  request or response, and an orphan still reaching the server. Delivering
  a request appends it to the receiver's pending requests, a mock's in its
  value, a server host's in its runtime; delivering a response is the
  client host's resolution of the promise at that position, inside the
  step.

**A request is named by its position**, never by an id. The network keeps,
per client, that client's outstanding requests in the order sent, and, per
server, the requests in progress there in the order delivered; the client
host keeps the first list as its unresolved promises, a server host the
second as its handlers in flight, and a call across the boundary says
which index it is about. A send appends to the client's list. A response
delivered to the client resolves index *p* and removes it, and the network
shifts every index above *p* in its legs and lists in the same step. A
server's response from index *j* removes it from both in-progress lists
alike. An abort removes index *p* on the client, and the network keeps
what it still holds of that request as an *orphan* — a request leg still
in flight, which may yet reach the server and change its state, or an
in-progress entry whose response is to be discarded — and drops a
response leg. A lost message changes no list: the promise stays
outstanding, which is what a lost message is, until the client aborts it.
Every change to an endpoint's list is a send, a delivery, a response or an
abort on the network, so the network sees each of them and holds the only
mapping between the two sides, and no shift ever touches a part the step
did not. Why positions and not ids is under Why.

**The expected schedule**, stated once. The candidates of a state are the
heads of the hosts' due queues, the oldest delivery in flight, and the
oldest request pending at a mock; the free one is the first in part order,
or the seed's pick. When nothing is due, nothing is in flight and nothing
is pending, no part expects anything, and the nearest `advance` of every
waiting host is a candidate: time proceeds for one host, the first in part
order or the seed's pick, and the others wait until nothing is due, in
flight or pending again, when every waiting host's advance is a candidate
once more. Every other pick is one deviation plus its keys: a reordering —
another candidate taken first — a delivery after a timer that was due, a
stall past any number of wake-ups, a fault. A reordering and a fault are
charged alike today; a key of their own for reorderings is under Open, and
the report tells them apart whichever way that goes.

**`seed`**, an option of the iterative search. Given one, the free
candidate of a state is `deepHash(state, hasher) mod k` into the candidate
list, with `hasher` a valsem hasher keyed by the seed
(`createMarvin32Hasher`, valsem 0.2): the same pick in every process for
the same seed, valsem version and model shape, and the hash incremental
over the parts' shared structure (valsem D68). Without a seed the free
candidate is the first, and a report reads as today. The report of a
seeded search re-counts the found path's deviations against the plain
order, so its number keeps its meaning though it is not the minimum;
`exhaustive` is untouched, being a statement about the space, which no seed
changes. Why a seeded mode, and what it needs of the cache, is under Why.

**Rules the parts obey.** Exactly two kinds of synchronous call cross a
part boundary: a delivery into a part, and an output into the network,
each a method of the receiving kind's runtime, reached by id through the
step. Requests and responses are values at the boundary, and the host
rebuilds `Request` and `Response` objects on its side. Replay never
registers, cancels or sends. A request is named by its position, above,
and nothing in a value counts the history. Nothing decides synchronously:
a part with a choice offers it as events. None of this can be enforced in
JavaScript; the detector is to rebuild every part from its value at a
sample of states, re-apply the step, and compare the product snapshot with
the live one. A difference means state lived outside the snapshots.

The drain that ends a step is a yield to the macrotask queue
(`setImmediate`, taken with the real timer as it was when stifinder loaded,
since a test that fakes timers fakes that one too). It is not the yield
D37 refused. That one would have let a body's own timers fire so the
search could catch what they decided — an accommodation of a body outside
the model. This one defines where a step ends, for parts that have no
timers of their own: their time is the host's, and nothing of theirs is on
the macrotask queue to fire.

For a program part the host sees every input it delivers and every output
it takes, so its log is the trace: `explain` on a reported path is the
replay with the log printed. D29's recorder argument stays for hand-written
models and for value parts, whose `ingest` receives it on `step`.

**Properties.** `invariant` and `terminalInvariant` over the product value,
as today; a state is terminal when no part has an event, and a steady
state is not an end. Instead, `reachable(cache, isGood)`: over the explored
transitions, mark the states `isGood` accepts, propagate backwards, and
report the shortest path to an explored state from which none is
reachable within the budget explored; a proof only when the result is
exhaustive. This is `findPath` above, with its first use.

#### Why

**Parts, not a scheduler.** The scheduler over `Decisions` proposed above
would still be one body. Both users want more: the Durable Object
simulator has many objects, each with storage, alarms and a history of its
own, and a client against a server is the same shape with two. Parts that
share nothing but messages have logs that diverge, and that is what lets
the product merge: two histories in which the server did things in a
different order, but the client received the same responses in the same
order, are one state. A single body between doubles never merges, because
it sees everything and its log is the whole history; the product is for
systems of several subjects. I/O automata (Lynch and Tuttle) are the
precedent: a channel is an automaton like the processes at its ends, and a
system is their composition.

**One interface, and a simulator ignorant of interactions.** The
alternative was a simulator that knew about hosts, networks and clocks.
Everything it would have known reduced to the five rules above; the rest
is each part's business, so a Cloudflare simulator brings its own parts
(stubs, input gates, storage) and the simulator does not change. D27
holds: the generic parts belong here, the platform's semantics stay with
it.

**One network, not a channel per link.** The grain of a part is the
independent owner, and the network is one. **Rejected:** a channel per
pair of endpoints that talk, the FIFO from one to the other, held for a
day (2026-10-18). It was argued from the cost of asking a state for its
events: one network's would walk every link. But the events are the
deliveries and losses of the messages in flight, so the walk is over
messages, not links, an idle link is nothing to walk, and channels walk
the same messages split across parts. What a single network has that
channels lack is correlation: it sees every send, delivery and abort of
every endpoint, so a request can be named by its position among that
endpoint's outstanding, where channels would have had to partition each
endpoint's list per peer and keep the pieces in step. And oldest-first is
then the network's own order, physics within a part, where across
channels it was part order and the candidates. The price is that the
network is touched on every step that moves a message, and snapshotted
each time; with a persistent value and a hasher that remembers (valsem
D68) that is an update proportional to what the step moved, not to what
the network holds, and the validation says so.

**A request is named by its position.** The alternative was ids from
per-part counters, the first draft's form. A counter is derivable from a
program part's log and costs nothing while the log stands; in a value
part, and in any part after a fold, it is a number in the state that
climbs with the history, and two states that differ in nothing but how
many requests came before do not merge. Position among the outstanding is
the identity with nothing in it but the present, at the price of the
shifts, which the network does in the step that moves them and nowhere
else. **Rejected:** letting the endpoints hold references to each other's
positions. A client-side shift would then have to rewrite the server's
value in a step that never touched the server.

**The zero-delay expected schedule.** A delivery is instant on the
baseline, and a timeout fires only as a deviation. **Rejected:** a nominal
latency per delivery, the first form. It is a made-up number, and with it
the baseline needed an "early" beside its "late". With none, the only
times in a run are the ones the code sets itself. **Rejected:**
newest-first delivery, the first prototype's default, which let each party
run undisturbed. Oldest first is what a network does when latencies are
equal; two clients that start together interleave on the baseline because
they do, and a lost update between them is a zero-deviation failure,
honestly. **Rejected:** processing that takes time. Any step may be
arbitrarily late in the model already, so "instant" and "later than
everything concurrent" are the two legs, and both are explored.

**Time is local, relative, and never read.** Each host keeps its own timers
as distances to fire; an advance subtracts, and hands over what reaches
zero to the host's queue. Within a host that is the HTML timer rule: due
order, registration order at equal dues (NodeRacer's rule for timers,
Endo et al., ICST 2020). No absolute time exists in the state, so a value
part whose tick changes nothing returns to the same state, the space of a
periodic system can be finite, and a search over it can be exhaustive.
**Rejected:** absolute time in the state, which grows without bound and
makes every tick a new state. **Rejected:** orderings alone, with no
distances: placing a newly set timer among a host's pending ones needs
their distances, or the model explores schedules no runtime produces
(Alur and Dill's regions are the general form; relative integers are the
practical stopping point for delays computed at run time). **Rejected for
the first delivery:** one aligned clock advancing every host together,
nearest wake-up first. It gives the baseline the code's durations imply,
at the price of a state per relative phase of the hosts' clocks, bounded
by the lcm of the periods, and it undoes the collapse of a tick to a
self-loop. With local clocks the price moves: when two parts both progress
on periodic timers, the one later in part order costs a deviation per tick
under the seedless pick. The ladder from there: every waiting host's
advance is a candidate, so a seed spreads the tax across the states a run
passes through; a seed cannot alternate in a fixpoint, since the hash of a
state that a round returns to picks the same host every round, and that is
the periodic case; the *turn* — the host whose wait is advanced next, kept
in the system's state and rotating among the hosts that wait, nothing while
one host is active and ×N states at most — gives alternation there,
deterministic and readable, at 1:1; aligned advance gives the real ratio
between periods at the deferred price of a state per phase, and stays as
the policy for the case the turn cannot serve. The two-client counter is
the validation that says how far up the ladder the first delivery must
go. **Rejected as the baseline:** a hash of the state to break ties among
waits. It varies only where the state already varies, so in a fixpoint it
is pinned, exactly where fairness is wanted; and it makes the expected
schedule shift with every unrelated change to the code, and with the hash
seed of the process, so the uncharged steps of a report are ones no reader
can fill in. **Adopted as a mode:** the same hash under a key the test
supplies, `seed`, with a deterministic hasher — see the next paragraph.
Clock reads are left out of the first delivery entirely: a read
puts an absolute number into the reader's log, and an abstract `Instant`
that avoids the number must know which instants the code still holds,
which a program part cannot know without checkpoints or declared
constants.

**Seeds, for the space that cannot be exhausted.** The state space, the
transitions and the merging are the same under every seed; a seed changes
only which edge out of each state is free. So with deviations unbounded a
seed reorders the finding and nothing else, and under a bounded budget it
chooses the neighbourhood: *d* deviations around baseline *s*, and *k*
seeds are *k* neighbourhoods — swarm verification (Holzmann). It finds a
different kind of bug. Distance from the plain schedule and PCT's depth
(how many ordering constraints a bug needs) are different measures: a bug
of depth one can lie ten deviations from the plain baseline, if B has to
progress nine ticks to reach it, and a random baseline satisfies one
constraint with probability about a half while B's progress costs it
nothing. The plain search finds what is near normal; the swarm finds what
is shallow in constraints and far from normal. The plain baseline stays
the default, since it is what makes a report readable, and a seeded search
is for a space `exhaustive` is out of reach for: exhausted, every seed
finds the same space. **What it needs.** The cache split in two: what the
model said — the event sets, the `applyEvent` results, the invariants,
which for a program part are the replays and so all the cost — is
seed-free and shared; what a search labelled — the order of events, the
cost vectors, the pending buckets — is per seed. Today both live in one
`StateSpaceCache`, and this is the reason to separate them. For three
parts or fewer, enumerating the part orders is a better swarm than random
seeds: complete over the one dimension that matters, each run's baseline
with a name. **Rejected:** hashing a projection of the state rather than
the whole, for stability under unrelated changes; in a seeded mode the
seed is arbitrary already, and whole-state variation is what gives
alternation when the state changes.

**Faults ride on carriers.** A lost response is an alternative to its
delivery; a server-side 500 is an alternative of the mock's answer to the
request.
A fault offered alone keeps a state from being an end (D7), and once
nothing nominates an expected event, each part's first event is a
candidate, whichever part it belongs to.

**All decisions are steps.** A decision made inside a drain cannot wait for
the search. Here every choice is an event of a part, so the harvest of D36
is not needed; a synchronous `decide` inside a program part is deferred,
with speculative execution of the expected step as the way to add it. That
fixes who the first delivery is for: the Durable Object simulator, the
remote counter and the outbox, whose choices are messages and timers.
kilde's sinks and sources decide synchronously, through `integer`, and
stay on `decisionModel` until that arrives.

**Values at the boundary, replay isolated, and a rebuild check.** A live
`Response` passed across would couple two runtimes; a replay that re-sent
its requests would double what the network already holds. The rebuild
check needs no knowledge of interfaces, and catches nondeterminism, module
state that survives a replay, and most hidden channels between parts.

**Steady states are not terminal.** The maintainer's call. A
positive-outcome query asks what a steady state would have raised, whether
the system got where it should, without declaring any state an end.

**Eviction is an event, and the fold.** A Durable Object's value is its
storage, its pending alarm, and the log of inputs since it last came into
memory; `restore` constructs it from storage and replays that log. The
storage alone would not do: an object mid-RPC holds its continuation in
memory, not in storage, and a restore from storage would drop it on the
baseline, where the live runtime must resume. Eviction is an event of the
part — a fault, charged like one — after which the log is empty and the
value is storage and alarm alone; that is where the proposal's checkpoint
rule says a part may fold, and here it is physically honest, since the
platform loses the in-memory state at exactly that point. Histories that
evict converge, and the log stays short because eviction is where it
resets. The three observations behind this paragraph, the grain and the
dynamic and lazy parts of the model — parts are dynamic, parts are
expensive to instantiate, and the grain of a part is a question — came
from the Durable Object simulator, 2026-10-18; the network as one part,
and positions, from working the client, network and server through on the
same day.

#### Validation

A differential oracle: systems of value parts only, against a hand-written
product `Model`, fuzzed as `oracle.test.ts` does. A second, for `program()`:
a value part wrapped as a program part — its reducer run behind a host,
requests in and responses out — must explore the same product as the value
part does, up to the log; that is what exercises replay, suppression and
the rebuild check against a known answer, which the first oracle never
reaches. `examples/remote-counter`
redone with its real clients over `mock` and `http`, with the same three
outcomes at the same costs. The transactional outbox: the real relay
against its explicit model, the duplicate at one timeout and one retry,
clean after the idempotency fix within the same budgets. The two-client
counter under the seedless pick, the seed, and the turn, for the deviation
at which the lost update appears under each. Runs and time under
breadth-first exploration before any change of exploration order: a
program part is replayed whenever the search asks about a state its live
runtime is not at, and breadth-first by steps asks around (the remedy is
under Deferred). A system of many idle parts and few active ones: the cost
of a state's events and of a step must follow the active and the touched
sets, not the namespace, and the network's snapshot must cost what the
step moved, not what the network holds.

#### Delivery

1. The `Host` interface and `webHost()`, for production code that takes its
   host as an argument: `fetch`, the timers, `timeoutSignal`, and `random`
   with a `uuid` on it, since a client that makes an idempotency key with
   `crypto.randomUUID()` diverges on replay and the outbox example is about
   that key; clock reads stay deferred, a key not being a time. Where it
   lives is open: a dependency-free subpath, `stifinder/host`, which
   revises D30 (stifinder is no longer a testing tool throughout) and puts
   a testing library in production bundles' dependency lists, or a separate
   small package. Its shape — timer ids as values, requests and responses
   as values — is dictated by `program()`, so it is delivered with step 3,
   not before it.
2. `system()` with value parts only: the registry and dynamic parts, the
   active set, the candidates and the free one, the merge rule, the
   touched-set step, the network with its positions, the differential
   oracle.
3. `program()` and the host: the log, resume or replay, suppression and
   comparison, the rebuild check, the second oracle.
4. `http()` faults, abort and orphans; `mock` alternatives.
5. `seed`, with the cache split and the re-counted report; the turn, if the
   two-client counter says so.
6. `reachable()`.
7. Examples, a README section, DESIGN.md §9.4, and decisions D38 onward
   cut from this entry.

#### Deferred, each with what would bring it in

- Aligned clocks: two parts progressing on periodic timers whose relative
  phase is the behaviour under test.
- `Instant` and clock reads: code that reads time. Instants incomparable
  across hosts unless the test declares a relation; relative offsets for
  the instants a part holds; declared constants to cap them.
- Checkpoints for program parts: histories that grow without bound, or
  crashes to model. A part folds to a value only where the system itself
  restarts from that value, or asserts it and a fold check verifies the
  assertion. For a Durable Object the fold is eviction, decided above.
- The `optional` mark above: faults that should not prevent an end.
- Durable Object networks: a second network part for the stubs, FIFO per
  pair with one shared break, owning the positions of its own interactions
  as `http` owns those of HTTP; the objects addressed by id and created on
  first delivery, as every dynamic part is. The simulator's own parts
  (input gates, storage) stay with it (D27).
- A part id that is not a string. The first delivery requires strings, so
  that part order is string order. A composite id (`{ namespace, name }`)
  wants a total order over values, which valsem does not have; when one is
  needed it should be structural — a rank per kind, then the kind's
  lexicographic order, a `[compare]` for value classes, refusal for what
  has none — and not an order by stable hash with a structural tie-break,
  which is faster on large values and unreadable in a report, where part
  order is shown; the hash order is a one-liner for a caller who wants it.
  Discussed 2026-10-18, left until an id needs it.
- Exploration order within a deviation level: depth-first along the live
  runtime, replaying only at branch points, the product's analogue of
  D36's harvest. D23 leaves the order within a level free; what is reported
  does not change.
- Streaming bodies; real servers as program parts, which need no new
  machinery; symmetry reduction; a horizon; synchronous decisions in
  program parts, which is what brings kilde's sinks and sources over.
