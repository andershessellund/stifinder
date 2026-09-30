# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub:
**[Report a vulnerability](https://github.com/andershessellund/stifinder/security/advisories/new)**.
Do not open a public issue or pull request for one.

A useful report says what an attacker controls, what they gain, and how to
reproduce it, ideally as a short script against a published version.

stifinder is maintained by one person. Reports are read and acknowledged as
soon as possible, and you will be told whether the report is accepted and what
the plan is. Fixes are released as a patch version with a GitHub security
advisory, crediting the reporter unless they prefer otherwise.

## Supported versions

Security fixes go into the latest published version only.

## What counts

stifinder explores a model its caller wrote: `getEvents` and `applyEvent` are
the caller's own code, and the states and events are the caller's own values.
It is a test-harness component, not a boundary for untrusted data. That
leaves a small surface. In scope, for example:

- a compromise of the published package or of the release pipeline described
  below;
- stifinder writing to a prototype, or to anything else outside its own cache,
  given states, events or cost keys of any shape.

Out of scope, by design:

- time and memory spent exploring a large state space: bounding the search is
  what `maxEdges`, `timeoutMs` and the budget are for, and they are the
  caller's to set;
- whatever a model's own callbacks do;
- the admission of states and events as values, which is
  [`valsem`](https://github.com/andershessellund/valsem)'s, and covered by
  [its policy](https://github.com/andershessellund/valsem/blob/main/SECURITY.md).

## How releases are protected

Published versions are built and staged by GitHub Actions from a tagged commit,
authenticated to npm by OIDC trusted publishing: no npm token exists. The
tarball is packed in a job whose only running package code is the TypeScript
compiler, and published from a job that installs nothing but npm. The tests,
the linter and the rest of the toolchain run in a third job, which holds
neither the tarball nor the credential. A staged version goes live only after
the maintainer approves it with a second factor, and carries a provenance
attestation linking it to its source commit and workflow run. Release tags
cannot be moved or deleted.

Version 0.0.1 predates this pipeline: it was published by hand and carries no
provenance attestation.
