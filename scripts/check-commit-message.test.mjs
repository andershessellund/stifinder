import { describe, it, expect } from 'vitest';
import { check } from './check-commit-message.mjs';

const block = (inner) => `Some prose.\n\nBEGIN_COMMIT_OVERRIDE\n${inner}\nEND_COMMIT_OVERRIDE\n\nMore prose.`;

describe('check-commit-message: what release-please will read from a PR', () => {
  it('reads the title when there is no override block, whatever the description says', () => {
    // The description is not part of the squash commit, so code in it is harmless now.
    const description = 'What broke:\n\nproduce(intern([0]), d => { d.push(c); d[1].y = 2; });\n\n| a | b |\n| --- | --- |';
    expect(check('fix: lost edits on pushed elements', description, 18)).toEqual({ problems: [], overridden: false });
    expect(check('chore(deps): bump the toolchain group with 2 updates', '<details>call(nested(1), 2)</details>', 6).problems).toEqual([]);
  });

  it('accepts titles with code in them', () => {
    for (const title of ['fix: handle produce(intern(x)) correctly', 'fix(draft): nested (parens (inside)) the summary', 'feat!: drop Node 22', 'fix: `d[1].y = 2` was lost']) {
      expect(check(title, '', 1).problems).toEqual([]);
    }
  });

  it('rejects a title release-please cannot parse', () => {
    const { problems } = check('not a conventional title', '', 1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^The PR title cannot be parsed/);
  });

  it('an override block is what release-please reads, so it must parse', () => {
    expect(check('fix: x', block('fix: the entry\n\nfix: a second entry'), 3)).toEqual({ problems: [], overridden: true });
    const bad = check('fix: x', block('produce(intern([0]), d => 1)'), 3);
    expect(bad.problems).toHaveLength(1);
    expect(bad.problems[0]).toMatch(/^The override block cannot be parsed/);
    expect(bad.problems[0]).toMatch(/the line: produce\(intern/);
    // One bad entry among good ones is still a dropped entry.
    expect(check('fix: x', block('fix: fine\n\nfix: also fine\n\nfeat: broken(nested(1), 2\nfoo(bar(1), 2)'), 3).problems).not.toEqual([]);
  });

  it('footers work inside an override block', () => {
    expect(check('chore: release 1.0.0', block('chore: release 1.0.0\n\nRelease-As: 1.0.0'), 40).problems).toEqual([]);
    expect(check('feat!: drop a thing', block('feat!: drop a thing\n\nBREAKING CHANGE: the thing is gone, use the other thing(s) instead'), 41).problems).toEqual([]);
  });

  it('catches footers that the title-only squash commit would silently lose', () => {
    const breaking = check('feat!: drop a thing', 'Drops it.\n\nBREAKING CHANGE: the thing is gone.', 5);
    expect(breaking.problems).toHaveLength(1);
    expect(breaking.problems[0]).toMatch(/"BREAKING CHANGE:" line outside an override block/);
    const releaseAs = check('chore: release 1.0.0', 'Time for 1.0.\n\nRelease-As: 1.0.0', 6);
    expect(releaseAs.problems[0]).toMatch(/"Release-As:".*the version will NOT be forced/);
    // Mentioning one mid-sentence, or in a code span, is not a footer.
    expect(check('docs: explain', 'Write a `BREAKING CHANGE:` line, or mention Release-As: inline.', 7).problems).toEqual([]);
    // …and a footer outside the block is caught even when a block exists.
    expect(check('feat!: x', block('feat!: x') + '\n\nBREAKING CHANGE: outside', 8).problems).toHaveLength(1);
  });

  it('catches a block that is empty or never closed', () => {
    expect(check('fix: x', 'BEGIN_COMMIT_OVERRIDE\n\nEND_COMMIT_OVERRIDE', 1).problems[0]).toMatch(/empty/);
    const open = check('fix: x', 'Prose.\n\nBEGIN_COMMIT_OVERRIDE\nfix: entry\n\nand then the rest of the description', 1);
    expect(open.problems.some((p) => /no END_COMMIT_OVERRIDE/.test(p))).toBe(true);
  });

  it('handles CRLF descriptions, which is what the GitHub web editor produces', () => {
    expect(check('fix: x', 'Prose.\r\n\r\nBEGIN_COMMIT_OVERRIDE\r\nfix: a\r\n\r\nfix: b\r\nEND_COMMIT_OVERRIDE\r\n', 1)).toEqual({ problems: [], overridden: true });
  });
});
