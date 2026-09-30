# Contributing to stifinder

Thanks for looking. stifinder is maintained by one person, so the process is
small, but it is the same for everyone, the maintainer included.

## Before you write code

For anything beyond a small fix, open an issue first. Which violation is
reported, and what the cache promises across budgets, are stated in the
[README](README.md); a change to either is a conversation that is cheaper
before the code exists.

## Setup

Node 22 or later and [pnpm](https://pnpm.io) (the version is pinned in
`package.json`; `corepack enable` picks it up).

```sh
pnpm install
pnpm build       # tsc
pnpm typecheck   # the tests' types too
pnpm test        # vitest
pnpm lint
pnpm check:package   # publint and are-the-types-wrong, on the packed tarball
```

CI runs the first four on Node 22 and on the latest Node, and the last one
once: it checks what the tests cannot see, since the tests import from `src/`
(the `exports` map, how the published types resolve). It also runs the
typecheck and the tests against the oldest `valsem` the peer range admits.

Tests sit beside the source, in `src/`. The examples in `examples/` have tests
too: the README quotes their output, and the tests are what keeps it true.

`src/oracle.test.ts` checks the search against a brute-force oracle on random
models. It runs a few hundred of them; after a change to the search, run it
on many more: `FUZZ_RUNS=20000 pnpm test oracle`.

## Pull requests

Every change reaches `main` through a pull request; direct pushes are blocked
for everyone. PRs are squash-merged, and **the PR title becomes the whole
commit on `main`**. The description stays on the pull request, which the
number in the commit title links to; it is not part of the commit.

The title must be a [Conventional Commit](https://www.conventionalcommits.org):

| Title | Meaning | Release |
| --- | --- | --- |
| `fix: …` | a bug fix | patch |
| `feat: …` | new public API or behaviour | minor |
| `feat!: …` / `fix!: …` | a breaking change | major |
| `docs:` `test:` `refactor:` `perf:` `ci:` `build:` `chore:` | no change a user can observe | none |

release-please builds the changelog from that title. When one title is not
enough, add an **override block** to the description. release-please then
reads only what is between the markers, in place of the title:

```
BEGIN_COMMIT_OVERRIDE
fix: the first changelog entry

fix: a second entry, for a PR that fixed two things
END_COMMIT_OVERRIDE
```

The block is also where a footer goes, below a header line and a blank line,
since the description itself is not a commit message and a footer written
there is never seen:

- a breaking change that needs explaining: `BREAKING CHANGE: what breaks, and
  what to do instead`. (A `!` in the title is enough to mark one; the footer
  adds the explanation to the changelog.)
- forcing a version: `Release-As: 1.0.0`.

Whatever release-please cannot parse, it drops without an error: no changelog
entry, no effect on the version. The `release notes can be generated` check
runs the same parser over the title and the block, and fails on a footer left
outside one. The same block, added to an already merged PR, corrects its
release notes after the fact.

Write the title as the changelog line you would want to read: it is one.

What a PR should contain:

- **Tests.** A bug fix starts with a test that fails without it.
- **Docs**, when behaviour changes: the README is the documentation.

## Versioning

stifinder follows [Semantic Versioning](https://semver.org). The public API is
everything exported from `stifinder`, with its documented behaviour and its
TypeScript types.

Breaking, and therefore a major version:

- removing or renaming an export, or changing a signature incompatibly;
- changing which violation is reported for a given model and budget;
- changing how cost is counted: what charges a deviation, or how cost keys add up;
- raising the floor: the minimum Node version, or the lower bound of the
  `valsem` peer range.

Not part of the API, and free to change in any release:

- **the order in which states are explored**, beyond what the reported
  violation depends on, and so the number of edges a search computes;
- **the text of error messages** (that an operation throws, and the error's
  type, are API; its wording is not);
- anything prefixed with `_` or marked `@internal` (the published types
  leave the latter out), and the layout of `dist/`;
- performance characteristics.

A type-only change that can break a build that compiled before is treated as
breaking, with one exception: corrections to a type that was wrong about the
runtime's behaviour are fixes.

## Releases

Releases are automated. [release-please](https://github.com/googleapis/release-please)
keeps a release PR open with the next version and the `CHANGELOG.md` entries
computed from the merged PR titles. Merging it tags the commit and creates the
GitHub Release; CI then stages the package on npm, and it goes live once the
maintainer approves the staged tarball. Do not edit the version in
`package.json` or `CHANGELOG.md` by hand.

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your contribution is licensed under the
project's [Apache-2.0 licence](LICENSE).
