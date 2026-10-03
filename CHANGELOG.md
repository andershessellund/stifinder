# Changelog

## [0.2.0](https://github.com/andershessellund/stifinder/compare/v0.1.0...v0.2.0) (2026-10-03)


### ⚠ BREAKING CHANGES

* stifinder runs on valsem 0.1, and the peer range is >=0.1.0 <0.2 ([#26](https://github.com/andershessellund/stifinder/issues/26))
* a budget bounds only the keys it names: a missing allowance is no limit, where it was zero
* explore(cache, {}) and exploreOnce(model, {}) now explore everything, deviations included, and exploreIteratively without a baseBudget allows any amount of the model's own cost keys. To allow none of a key, name it with 0.

### Features

* `check` runs a search as a test: it rejects with the violation rendered, and when a limit cut the search short ([8ec3bca](https://github.com/andershessellund/stifinder/commit/8ec3bca9407b8d84119f7ad14e10a72f6e833287))
* a body of code is explored through the decisions it asks for: `decisionModel(body)` with `maybe`, `choose` and `integer`, `decisionsOf`, and `runOnce` to see a failure again ([0a54a64](https://github.com/andershessellund/stifinder/commit/0a54a6477e35555a90369163583252d124a85873))
* a budget bounds only the keys it names: a missing allowance is no limit, where it was zero ([51faacc](https://github.com/andershessellund/stifinder/commit/51faacc83350f0504a02c48722501c6f3d440b18))
* a model may describe its events and states, and `formatViolation` renders a violation in those words, with what each step was charged ([8ec3bca](https://github.com/andershessellund/stifinder/commit/8ec3bca9407b8d84119f7ad14e10a72f6e833287))
* a model may say how its violations are rendered, with `report`; `formatViolation` and `ViolationError` take `{ steps: 'charged' }` to list the charged steps alone ([0a54a64](https://github.com/andershessellund/stifinder/commit/0a54a6477e35555a90369163583252d124a85873))
* every event costs one `__steps__`, a cost key like any other: a budget can bound the length of a run, and a state reached in fewer steps by more deviations is kept beside the cheaper way to it ([51faacc](https://github.com/andershessellund/stifinder/commit/51faacc83350f0504a02c48722501c6f3d440b18))
* stifinder runs on valsem 0.1, and the peer range is &gt;=0.1.0 &lt;0.2 ([#26](https://github.com/andershessellund/stifinder/issues/26)) ([060fbd1](https://github.com/andershessellund/stifinder/commit/060fbd1050fb7706033928f1c780417612ddf7f7))


### Bug Fixes

* a decision state is a ValueList, so a long run is linear and not quadratic ([#25](https://github.com/andershessellund/stifinder/issues/25)) ([6f8a4a1](https://github.com/andershessellund/stifinder/commit/6f8a4a1a85d71a6465773add73eaf4d80e422906))
* budgets and limits are checked, and NaN or a negative value is a RangeError instead of being read as no limit or as zero ([6587c66](https://github.com/andershessellund/stifinder/commit/6587c66e97766c8892057232f55353769d54df3a))
* exploreIteratively's edgesAddedThisRun counts the whole run, as maxEdges does ([6587c66](https://github.com/andershessellund/stifinder/commit/6587c66e97766c8892057232f55353769d54df3a))
* shortestViolation ends on any budget, an unbounded one included ([6587c66](https://github.com/andershessellund/stifinder/commit/6587c66e97766c8892057232f55353769d54df3a))
* states and events in results are canonical, like initialState and badState, and a model that mutates a state it is given fails at that step ([6587c66](https://github.com/andershessellund/stifinder/commit/6587c66e97766c8892057232f55353769d54df3a))


### Performance Improvements

* explore takes each depth in turn instead of searching for the next, so a long run is no longer quadratic ([6587c66](https://github.com/andershessellund/stifinder/commit/6587c66e97766c8892057232f55353769d54df3a))

## [0.1.0](https://github.com/andershessellund/stifinder/compare/v0.0.1...v0.1.0) (2026-09-23)


### ⚠ BREAKING CHANGES

* ApplyResult is { to } or { error }, and a badState returned by applyEvent is dropped: badState reports a state that failed invariant or terminalInvariant
* the cache's events, apply, reached, invariants, initialError, errorEdges, pending and deferred, its methods getEvents, applyEvent, hasApplied, checkInvariant and addCostEntry, and the types PredecessorEntry, CostEntry, ErrorEdgeEntry and PendingEdge are internal, and left out of the published types. The counters are read-only. cache.config is now cache.model; config stays, deprecated.

### Features

* `Model` is the name of what was `ExplorerConfig`, which stays as a deprecated alias ([03eb316](https://github.com/andershessellund/stifinder/commit/03eb3166b8c591392dd6e4a1a004e4694c1747ef))
* a model may state a terminalInvariant, checked where nothing more can happen ([#13](https://github.com/andershessellund/stifinder/issues/13)) ([ec5ee35](https://github.com/andershessellund/stifinder/commit/ec5ee35c7075e95fb7f4590544c5204db4f6d1e0))
* a model may state an invariant, and a violation of it carries the state that failed ([#12](https://github.com/andershessellund/stifinder/issues/12)) ([00e1193](https://github.com/andershessellund/stifinder/commit/00e119342dae8b63c0f835745be0530228df6faa))
* a model's callbacks may be synchronous ([03eb316](https://github.com/andershessellund/stifinder/commit/03eb3166b8c591392dd6e4a1a004e4694c1747ef))
* a StateSpaceCache's API is its model, initialState, exhaustive, statesExplored and read-only counters; what it stores is internal ([72a9e10](https://github.com/andershessellund/stifinder/commit/72a9e10eaee444f5d18416f3290b4e62f3df46a9))
* a violation reports its total cost, and each step the index of its event ([#9](https://github.com/andershessellund/stifinder/issues/9)) ([f4966bd](https://github.com/andershessellund/stifinder/commit/f4966bda67f8707dd2e8e58d0a3cfc5473f4afeb))
* an event's `cost` may be omitted ([03eb316](https://github.com/andershessellund/stifinder/commit/03eb3166b8c591392dd6e4a1a004e4694c1747ef))
* ApplyResult is { to } or { error }, and a badState returned by applyEvent is dropped: badState reports a state that failed invariant or terminalInvariant ([72a9e10](https://github.com/andershessellund/stifinder/commit/72a9e10eaee444f5d18416f3290b4e62f3df46a9))
* every result has `exhaustive`, true once no edge is left at any budget: with no violation, that is a proof ([03eb316](https://github.com/andershessellund/stifinder/commit/03eb3166b8c591392dd6e4a1a004e4694c1747ef))
* exploreIteratively takes a model directly, or a cache to keep ([03eb316](https://github.com/andershessellund/stifinder/commit/03eb3166b8c591392dd6e4a1a004e4694c1747ef))


### Bug Fixes

* a callback that throws leaves the cache consistent, and the next call meets the same throw instead of reporting a proof ([d325bcc](https://github.com/andershessellund/stifinder/commit/d325bcc7cb6846cc86db3557ff7b5b80e9703d9d))
* a result is exhaustive only when its own budget covers the whole cache, so a kept cache no longer reports a false proof ([d325bcc](https://github.com/andershessellund/stifinder/commit/d325bcc7cb6846cc86db3557ff7b5b80e9703d9d))
* an unbounded deviation budget, or maxDeviations: Infinity, ends instead of hanging ([d325bcc](https://github.com/andershessellund/stifinder/commit/d325bcc7cb6846cc86db3557ff7b5b80e9703d9d))
