import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRANCH_FORMAT,
  parseBlamePorcelain,
  parseBranches,
  parseStashes,
  recentBranches,
  REFLOG_FORMAT,
  STASH_FORMAT,
  UNCOMMITTED_SHA,
} from '../src/lib/parse';
import { relativeTime } from '../src/lib/time';
import { commitUrl, parseRemoteUrl } from '../src/lib/remote';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('blame porcelain: commit info not repeated', () => {
  const out = [
    `${A} 1 1 2`,
    'author Alice',
    'author-mail <alice@example.com>',
    'author-time 1700000000',
    'author-tz +0100',
    'summary First commit',
    'filename f.txt',
    '\tline 1',
    `${A} 2 2`,
    '\tline 2',
    `${UNCOMMITTED_SHA} 3 3 1`,
    'author Not Committed Yet',
    'author-mail <not.committed.yet>',
    'author-time 1700000100',
    'summary Version of f.txt from f.txt',
    'filename f.txt',
    '\tline 3',
    `${B} 1 4 1`,
    'author Bob',
    'author-mail <bob@example.com>',
    'author-time 1700000200',
    'summary Second',
    'previous ' + A + ' f.txt',
    'filename f.txt',
    '\tline 4',
    '',
  ].join('\n');
  const blame = parseBlamePorcelain(out);
  assert.deepEqual(blame.lines, [A, A, UNCOMMITTED_SHA, B]);
  assert.deepEqual(blame.commits.get(A), {
    sha: A,
    author: 'Alice',
    authorMail: 'alice@example.com',
    authorTime: 1700000000,
    summary: 'First commit',
  });
  assert.equal(blame.commits.get(B)?.author, 'Bob');
});

test('branches: current, upstream, ahead/behind', () => {
  const out = ['*\x00main\x00origin/main\x00ahead 2, behind 1\x00001700000000\x00fix', ' \x00feat\x00\x00\x00001690000000\x00wip', ' \x00old\x00origin/old\x00gone\x00001680000000\x00x', ''].join('\n');
  const branches = parseBranches(out);
  assert.equal(branches.length, 3);
  assert.deepEqual(branches[0], { name: 'main', current: true, upstream: 'origin/main', track: '↑2 ↓1', time: 1700000000, subject: 'fix' });
  assert.equal(branches[1].current, false);
  assert.equal(branches[1].track, '');
  assert.equal(branches[2].track, 'upstream gone');
});

test('stashes: custom message and WIP', () => {
  const out = ['stash@{0}\x00' + A + '\x00001700000000\x00On main: my message', 'stash@{1}\x00' + B + '\x00001690000000\x00WIP on feat: abc1234 subject: with colon', ''].join('\n');
  const [s0, s1] = parseStashes(out);
  assert.deepEqual(s0, { ref: 'stash@{0}', sha: A, time: 1700000000, branch: 'main', message: 'my message', wip: false });
  assert.equal(s1.branch, 'feat');
  assert.equal(s1.message, 'abc1234 subject: with colon');
  assert.equal(s1.wip, true);
});

test('recent branches from the reflog', () => {
  const reflog = [
    'HEAD@{1700000500}\x00checkout: moving from feat to main',
    'HEAD@{1700000400}\x00commit: stuff',
    'HEAD@{1700000300}\x00checkout: moving from 1234abcd to feat', // detached HEAD
    'HEAD@{1700000200}\x00checkout: moving from deleted to 1234abcd',
    'HEAD@{1700000100}\x00checkout: moving from main to deleted',
    'HEAD@{1700000050}\x00checkout: moving from dev to main',
  ].join('\n');
  const existing = new Set(['main', 'feat', 'dev']);
  assert.deepEqual(recentBranches(reflog, existing, 'main', 10), [
    { name: 'feat', time: 1700000500 },
    { name: 'dev', time: 1700000050 },
  ]);
  assert.deepEqual(recentBranches(reflog, existing, 'main', 1), [{ name: 'feat', time: 1700000500 }]);
});

test('relative dates', () => {
  const now = 1_700_000_000_000;
  const s = now / 1000;
  assert.equal(relativeTime(s - 10, now), 'just now');
  assert.equal(relativeTime(s - 5 * 60, now), '5 minutes ago');
  assert.equal(relativeTime(s - 3 * 3600, now), '3 hours ago');
  assert.equal(relativeTime(s - 26 * 3600, now), 'yesterday');
  assert.equal(relativeTime(s - 3 * 86400, now), '3 days ago');
  assert.equal(relativeTime(s - 400 * 86400, now), 'last year');
});

test('formats against a real git repository', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'git-oeil-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  const gitIn = (input: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', input });

  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Tester');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'f.txt'), 'one\ntwo\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('switch', '-q', '-c', 'feat');
  writeFileSync(join(dir, 'f.txt'), 'one\ntwo\nthree\n');
  git('commit', '-q', '-am', 'three');
  git('switch', '-q', 'main');
  writeFileSync(join(dir, 'f.txt'), 'ONE\ntwo\n');
  git('stash', 'push', '-q', '-m', 'my stash');

  // Blame of modified, unsaved content, as the extension does.
  const blame = parseBlamePorcelain(gitIn('one\nchanged\n', 'blame', '--porcelain', '--contents', '-', '--', 'f.txt'));
  assert.equal(blame.lines.length, 2);
  assert.equal(blame.commits.get(blame.lines[0])?.summary, 'first');
  assert.equal(blame.commits.get(blame.lines[0])?.authorMail, 'test@example.com');
  assert.equal(blame.lines[1], UNCOMMITTED_SHA);

  const branches = parseBranches(git('for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'));
  assert.deepEqual(branches.map((b) => [b.name, b.current]).sort(), [['feat', false], ['main', true]]);

  const stashes = parseStashes(git('stash', 'list', `--format=${STASH_FORMAT}`));
  assert.equal(stashes.length, 1);
  assert.equal(stashes[0].ref, 'stash@{0}');
  assert.equal(stashes[0].message, 'my stash');
  assert.equal(stashes[0].branch, 'main');

  const reflog = git('reflog', 'show', '--date=unix', `--format=${REFLOG_FORMAT}`, 'HEAD');
  const recent = recentBranches(reflog, new Set(['main', 'feat']), 'main', 10);
  assert.deepEqual(recent.map((r) => r.name), ['feat']);
  assert.ok(recent[0].time > 1_600_000_000);
});

test('remote URL to web commit link', () => {
  const sha = 'c'.repeat(40);
  const link = (url: string) => {
    const remote = parseRemoteUrl(url);
    return remote && `${remote.provider} ${commitUrl(remote, sha)}`;
  };
  assert.equal(link('git@github.com:owner/repo.git'), `GitHub https://github.com/owner/repo/commit/${sha}`);
  assert.equal(link('https://github.com/owner/repo'), `GitHub https://github.com/owner/repo/commit/${sha}`);
  assert.equal(link('https://user@github.com/owner/repo.git/'), `GitHub https://github.com/owner/repo/commit/${sha}`);
  assert.equal(link('ssh://git@ssh.github.com:443/owner/repo.git'), `GitHub https://github.com/owner/repo/commit/${sha}`);
  assert.equal(link('git@github.com-work:owner/repo.git'), `GitHub https://github.com/owner/repo/commit/${sha}`);
  assert.equal(link('git@gitlab.com:group/sub/repo.git'), `GitLab https://gitlab.com/group/sub/repo/-/commit/${sha}`);
  assert.equal(
    link('ssh://git@gitlab.example.org:2222/team/repo.git'),
    `GitLab https://gitlab.example.org/team/repo/-/commit/${sha}`,
  );
  assert.equal(
    link('https://gitlab.example.org:8443/team/repo.git'),
    `GitLab https://gitlab.example.org:8443/team/repo/-/commit/${sha}`,
  );
  assert.equal(link('git@bitbucket.org:owner/repo.git'), null);
  assert.equal(link('/srv/git/repo.git'), null);
  assert.equal(link(''), null);
});
