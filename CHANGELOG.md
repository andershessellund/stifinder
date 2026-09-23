# Changelog

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
