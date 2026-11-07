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

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

test('blame porcelain : infos de commit non répétées', () => {
  const out = [
    `${A} 1 1 2`,
    'author Alice',
    'author-mail <alice@example.com>',
    'author-time 1700000000',
    'author-tz +0100',
    'summary Premier commit',
    'filename f.txt',
    '\tligne 1',
    `${A} 2 2`,
    '\tligne 2',
    `${UNCOMMITTED_SHA} 3 3 1`,
    'author Not Committed Yet',
    'author-mail <not.committed.yet>',
    'author-time 1700000100',
    'summary Version of f.txt from f.txt',
    'filename f.txt',
    '\tligne 3',
    `${B} 1 4 1`,
    'author Bob',
    'author-mail <bob@example.com>',
    'author-time 1700000200',
    'summary Second',
    'previous ' + A + ' f.txt',
    'filename f.txt',
    '\tligne 4',
    '',
  ].join('\n');
  const blame = parseBlamePorcelain(out);
  assert.deepEqual(blame.lines, [A, A, UNCOMMITTED_SHA, B]);
  assert.deepEqual(blame.commits.get(A), {
    sha: A,
    author: 'Alice',
    authorMail: 'alice@example.com',
    authorTime: 1700000000,
    summary: 'Premier commit',
  });
  assert.equal(blame.commits.get(B)?.author, 'Bob');
});

test('branches : courante, upstream, avance/retard', () => {
  const out = ['*\x00main\x00origin/main\x00ahead 2, behind 1\x00001700000000\x00fix', ' \x00feat\x00\x00\x00001690000000\x00wip', ' \x00old\x00origin/old\x00gone\x00001680000000\x00x', ''].join('\n');
  const branches = parseBranches(out);
  assert.equal(branches.length, 3);
  assert.deepEqual(branches[0], { name: 'main', current: true, upstream: 'origin/main', track: '↑2 ↓1', time: 1700000000, subject: 'fix' });
  assert.equal(branches[1].current, false);
  assert.equal(branches[1].track, '');
  assert.equal(branches[2].track, 'upstream supprimé');
});

test('stashs : message perso et WIP', () => {
  const out = ['stash@{0}\x00' + A + '\x00001700000000\x00On main: mon message', 'stash@{1}\x00' + B + '\x00001690000000\x00WIP on feat: abc1234 sujet: avec deux-points', ''].join('\n');
  const [s0, s1] = parseStashes(out);
  assert.deepEqual(s0, { ref: 'stash@{0}', sha: A, time: 1700000000, branch: 'main', message: 'mon message', wip: false });
  assert.equal(s1.branch, 'feat');
  assert.equal(s1.message, 'abc1234 sujet: avec deux-points');
  assert.equal(s1.wip, true);
});

test('branches récentes depuis le reflog', () => {
  const reflog = [
    'HEAD@{1700000500}\x00checkout: moving from feat to main',
    'HEAD@{1700000400}\x00commit: truc',
    'HEAD@{1700000300}\x00checkout: moving from 1234abcd to feat', // HEAD détachée
    'HEAD@{1700000200}\x00checkout: moving from supprimee to 1234abcd',
    'HEAD@{1700000100}\x00checkout: moving from main to supprimee',
    'HEAD@{1700000050}\x00checkout: moving from dev to main',
  ].join('\n');
  const existing = new Set(['main', 'feat', 'dev']);
  assert.deepEqual(recentBranches(reflog, existing, 'main', 10), [
    { name: 'feat', time: 1700000500 },
    { name: 'dev', time: 1700000050 },
  ]);
  assert.deepEqual(recentBranches(reflog, existing, 'main', 1), [{ name: 'feat', time: 1700000500 }]);
});

test('dates relatives', () => {
  const now = 1_700_000_000_000;
  const s = now / 1000;
  assert.equal(relativeTime(s - 10, now), "à l'instant");
  assert.equal(relativeTime(s - 5 * 60, now), 'il y a 5 minutes');
  assert.equal(relativeTime(s - 3 * 3600, now), 'il y a 3 heures');
  assert.equal(relativeTime(s - 26 * 3600, now), 'hier');
  assert.equal(relativeTime(s - 3 * 86400, now), 'il y a 3 jours');
  assert.equal(relativeTime(s - 400 * 86400, now), "l’année dernière");
});

test('formats contre un vrai dépôt git', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'git-oeil-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8' });
  const gitIn = (input: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, env, encoding: 'utf8', input });

  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Testeur');
  git('config', 'user.email', 'test@example.com');
  writeFileSync(join(dir, 'f.txt'), 'un\ndeux\n');
  git('add', '.');
  git('commit', '-q', '-m', 'premier');
  git('switch', '-q', '-c', 'feat');
  writeFileSync(join(dir, 'f.txt'), 'un\ndeux\ntrois\n');
  git('commit', '-q', '-am', 'trois');
  git('switch', '-q', 'main');
  writeFileSync(join(dir, 'f.txt'), 'UN\ndeux\n');
  git('stash', 'push', '-q', '-m', 'mon stash');

  // Blame d'un contenu modifié non enregistré, comme le fait l'extension.
  const blame = parseBlamePorcelain(gitIn('un\nmodifié\n', 'blame', '--porcelain', '--contents', '-', '--', 'f.txt'));
  assert.equal(blame.lines.length, 2);
  assert.equal(blame.commits.get(blame.lines[0])?.summary, 'premier');
  assert.equal(blame.commits.get(blame.lines[0])?.authorMail, 'test@example.com');
  assert.equal(blame.lines[1], UNCOMMITTED_SHA);

  const branches = parseBranches(git('for-each-ref', `--format=${BRANCH_FORMAT}`, 'refs/heads'));
  assert.deepEqual(branches.map((b) => [b.name, b.current]).sort(), [['feat', false], ['main', true]]);

  const stashes = parseStashes(git('stash', 'list', `--format=${STASH_FORMAT}`));
  assert.equal(stashes.length, 1);
  assert.equal(stashes[0].ref, 'stash@{0}');
  assert.equal(stashes[0].message, 'mon stash');
  assert.equal(stashes[0].branch, 'main');

  const reflog = git('reflog', 'show', '--date=unix', `--format=${REFLOG_FORMAT}`, 'HEAD');
  const recent = recentBranches(reflog, new Set(['main', 'feat']), 'main', 10);
  assert.deepEqual(recent.map((r) => r.name), ['feat']);
  assert.ok(recent[0].time > 1_600_000_000);
});
