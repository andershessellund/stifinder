// ---------------------------------------------------------------------------
// stifinder — the one entry point.
//
//   search.ts     the model, the cache and the search over it
//   report.ts     a violation rendered for a reader, and the errors a test sees
//   check.ts      a search run as a test
//   decisions.ts  a body of code as a model, through the decisions it asks for
//   system.ts     parts composed as one model: the kinds, the step, the messages
//   program.ts    real code behind a host, as a part
//   parts.ts      the network between clients and servers, and a server as a reducer
//   host.ts       what production code takes its platform from; also `stifinder/host`
//
// How it works is in DESIGN.md, and why in DECISIONS.md, both at the
// repository root.
// ---------------------------------------------------------------------------

export * from './search.js';
export * from './report.js';
export * from './check.js';
export * from './decisions.js';
export * from './system.js';
export * from './program.js';
export * from './parts.js';
export * from './host.js';
