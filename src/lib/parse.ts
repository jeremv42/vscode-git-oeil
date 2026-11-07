// Parsing des sorties git. Aucune dépendance à vscode : testé avec node:test.

export const UNCOMMITTED_SHA = '0'.repeat(40);

export interface CommitInfo {
  sha: string;
  author: string;
  authorMail: string; // sans les chevrons
  authorTime: number; // secondes epoch
  summary: string;
}

export interface Blame {
  /** sha du commit pour chaque ligne (index 0 = ligne 1). */
  lines: string[];
  commits: Map<string, CommitInfo>;
}

const BLAME_HEADER = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

/** Sortie de `git blame --porcelain`. */
export function parseBlamePorcelain(out: string): Blame {
  const lines: string[] = [];
  const commits = new Map<string, CommitInfo>();
  let current: CommitInfo | undefined;
  let finalLine = 0;

  for (const raw of out.split('\n')) {
    if (raw.startsWith('\t')) {
      if (current) lines[finalLine - 1] = current.sha;
      continue;
    }
    const header = BLAME_HEADER.exec(raw);
    if (header) {
      const sha = header[1];
      finalLine = Number(header[2]);
      current = commits.get(sha);
      if (!current) {
        current = { sha, author: '', authorMail: '', authorTime: 0, summary: '' };
        commits.set(sha, current);
      }
      continue;
    }
    if (!current) continue;
    const space = raw.indexOf(' ');
    const key = space < 0 ? raw : raw.slice(0, space);
    const value = space < 0 ? '' : raw.slice(space + 1);
    switch (key) {
      case 'author':
        current.author = value;
        break;
      case 'author-mail':
        current.authorMail = value.replace(/^<|>$/g, '');
        break;
      case 'author-time':
        current.authorTime = Number(value);
        break;
      case 'summary':
        current.summary = value;
        break;
    }
  }
  return { lines, commits };
}

export interface Branch {
  name: string;
  current: boolean;
  upstream: string;
  /** « ↑1 ↓2 », « upstream supprimé » ou ''. */
  track: string;
  time: number; // date du dernier commit, secondes epoch
  subject: string;
}

export const BRANCH_FORMAT =
  '%(HEAD)%00%(refname:short)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)';

/** Sortie de `git for-each-ref --format=BRANCH_FORMAT refs/heads`. */
export function parseBranches(out: string): Branch[] {
  return out
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const [head, name, upstream, track, time, subject] = l.split('\0');
      return {
        name,
        current: head === '*',
        upstream: upstream ?? '',
        track: formatTrack(track ?? ''),
        time: Number(time) || 0,
        subject: subject ?? '',
      };
    });
}

function formatTrack(track: string): string {
  if (track === 'gone') return 'upstream supprimé';
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return [ahead && `↑${ahead[1]}`, behind && `↓${behind[1]}`].filter(Boolean).join(' ');
}

export interface Stash {
  ref: string; // stash@{0}
  sha: string;
  time: number;
  branch: string;
  message: string;
  wip: boolean; // message généré par git (« WIP on … »)
}

export const STASH_FORMAT = '%gd%x00%H%x00%ct%x00%gs';

/** Sortie de `git stash list --format=STASH_FORMAT`. */
export function parseStashes(out: string): Stash[] {
  return out
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => {
      const [ref, sha, time, subject = ''] = l.split('\0');
      const m = /^(WIP on|On) ([^:]+): (.*)$/.exec(subject);
      return {
        ref,
        sha,
        time: Number(time) || 0,
        branch: m ? m[2] : '',
        message: m ? m[3] : subject,
        wip: m ? m[1] === 'WIP on' : false,
      };
    });
}

export interface RecentBranch {
  name: string;
  time: number; // dernier passage sur / depuis la branche, secondes epoch
}

export const REFLOG_FORMAT = '%gd%x00%gs';

/**
 * Branches récemment utilisées, d'après `git reflog show --date=unix --format=REFLOG_FORMAT HEAD`
 * (entrées les plus récentes d'abord). Ne garde que les branches locales encore existantes,
 * sans la branche courante.
 */
export function recentBranches(
  reflog: string,
  existing: ReadonlySet<string>,
  current: string | undefined,
  max: number,
): RecentBranch[] {
  const result: RecentBranch[] = [];
  const seen = new Set<string>();
  if (current) seen.add(current);

  for (const line of reflog.split('\n')) {
    if (result.length >= max) break;
    const [selector = '', subject = ''] = line.split('\0');
    const m = /^checkout: moving from (.+) to (.+)$/.exec(subject);
    if (!m) continue;
    const time = Number(/@\{(\d+)\}$/.exec(selector)?.[1]) || 0;
    // Destination puis origine : les deux branches ont été utilisées à ce moment-là.
    for (const name of [m[2], m[1]]) {
      if (seen.has(name) || !existing.has(name)) continue;
      seen.add(name);
      result.push({ name, time });
      if (result.length >= max) break;
    }
  }
  return result;
}
