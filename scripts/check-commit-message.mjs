// ---------------------------------------------------------------------------
// Will release-please read this pull request the way its author means?
//
// main takes squash merges, and the squash commit is the PR TITLE ONLY (a
// repository setting). release-please therefore reads two things, and nothing
// else: the title, from the commit, and an optional override block, which it
// fetches from the PR description:
//
//     BEGIN_COMMIT_OVERRIDE
//     fix: one line per changelog entry
//     END_COMMIT_OVERRIDE
//
// It parses both with a strict Conventional Commits grammar, and what it cannot
// parse it DROPS — no changelog entry, no effect on the next version — with a
// line in a workflow log nobody reads. This runs the same parser, at the same
// version, on those same two things.
//
// It also catches the quiet failure the title-only setting introduces: a
// `BREAKING CHANGE:` or `Release-As:` footer written in the description is no
// longer part of any commit, so release-please never sees it unless it is
// inside an override block.
//
// (An earlier version checked whole descriptions, because the squash commit
// then included them. It had to reproduce how GitHub re-wraps a description,
// which is undocumented and was not exact for HTML. Making the body blank
// removed that failure by construction, and most of this script with it.)
//
// Reads PR_TITLE, PR_BODY and PR_NUMBER from the environment.
// ---------------------------------------------------------------------------
import { parser } from '@conventional-commits/parser';

const TYPES = 'feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert';
const BEGIN = 'BEGIN_COMMIT_OVERRIDE';
const END = 'END_COMMIT_OVERRIDE';

/** release-please's splitMessages (src/commit.ts): one message may hold several conventional commits. */
function splitMessages(message) {
  const parts = message.split('BEGIN_NESTED_COMMIT');
  const messages = [parts.shift()];
  for (const part of parts) {
    const [nested, ...rest] = part.split('END_NESTED_COMMIT');
    messages.push(nested);
    messages[0] += rest.join('END_NESTED_COMMIT');
  }
  const split = messages[0].split(new RegExp(`\\r?\\n\\r?\\n(?=(?:${TYPES})(?:\\(.*?\\))?: )`)).filter(Boolean);
  return [...split, ...messages.slice(1)];
}

/** Problems found when parsing `message` as release-please would. */
function parseProblems(message, what) {
  const problems = [];
  for (const part of splitMessages(message)) {
    try {
      parser(part);
    } catch (error) {
      const at = /at (\d+):(\d+)/.exec(String(error.message));
      const line = at ? part.split(/\r?\n/)[Number(at[1]) - 1] : part.split(/\r?\n/)[0];
      problems.push(`${what} cannot be parsed (${error.message}).\n    the line: ${line}`);
    }
  }
  return problems;
}

/**
 * The override block of a description, as release-please extracts it
 * (preprocessCommitMessage), and the description with that block removed.
 */
function splitDescription(body) {
  const sections = body.split(BEGIN);
  if (sections.length < 2) return { override: undefined, rest: body, unterminated: false };
  const afterBegin = sections.slice(1).join(BEGIN);
  const end = afterBegin.indexOf(END);
  return {
    override: (end === -1 ? afterBegin : afterBegin.slice(0, end)).trim(),
    rest: sections[0] + (end === -1 ? '' : afterBegin.slice(end + END.length)),
    unterminated: end === -1,
  };
}

/** Everything wrong with how release-please will read this PR; empty when all is well. */
export function check(title, body, number) {
  const description = (body ?? '').replace(/\r\n/g, '\n');
  const problems = [...parseProblems(`${title} (#${number})`, 'The PR title')];
  const { override, rest, unterminated } = splitDescription(description);

  if (override !== undefined) {
    if (unterminated) problems.push(`The description has ${BEGIN} but no ${END}: release-please would read everything after the marker.`);
    if (override === '') problems.push(`The override block is empty: release-please ignores an empty block and uses the PR title.`);
    else problems.push(...parseProblems(override, 'The override block'));
  }

  // Footers only count inside a commit message, and the description is not one.
  for (const [pattern, name, consequence] of [
    [/^BREAKING[ -]CHANGE:/m, 'BREAKING CHANGE:', 'the changelog will not carry this explanation'],
    [/^Release-As:/im, 'Release-As:', 'the version will NOT be forced'],
  ]) {
    if (pattern.test(rest)) {
      problems.push(
        `The description has a "${name}" line outside an override block. The squash commit is the title only, ` +
          `so release-please never sees it: ${consequence}. Move it into an override block, below a header line.`,
      );
    }
  }
  return { problems, overridden: override !== undefined };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { PR_TITLE: title = '', PR_BODY: body = '', PR_NUMBER: number = '0' } = process.env;
  const { problems, overridden } = check(title, body, number);
  if (problems.length === 0) {
    console.log(`ok: release-please will read ${overridden ? 'the override block in the description' : 'the PR title'}.`);
    process.exit(0);
  }
  for (const problem of problems) console.log(`- ${problem}\n`);
  console.log(`release-please reads the PR title and, if present, an override block in the
description. What it cannot parse it drops without an error. An override block
looks like this; a footer goes below a header line, after a blank line:

  ${BEGIN}
  feat!: the changelog entry

  BREAKING CHANGE: what breaks, and what to do instead
  ${END}

See CONTRIBUTING.md, "Pull requests".`);
  process.exit(1);
}
