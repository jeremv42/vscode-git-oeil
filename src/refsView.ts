import * as vscode from 'vscode';
import * as path from 'node:path';
import { git } from './git';
import {
  BRANCH_FORMAT,
  parseBranches,
  parseStashes,
  recentBranches,
  REFLOG_FORMAT,
  STASH_FORMAT,
  type Branch,
  type RecentBranch,
  type Stash,
} from './lib/parse';
import { relativeTime } from './lib/time';

interface RepoData {
  branches: Branch[];
  stashes: Stash[];
  recent: RecentBranch[];
}

type GroupKind = 'recent' | 'branches' | 'stashes';

export type Node = RepoNode | GroupNode | BranchNode | StashNode;

export class RepoNode extends vscode.TreeItem {
  readonly kind = 'repo';
  constructor(readonly root: string) {
    super(path.basename(root), vscode.TreeItemCollapsibleState.Expanded);
    this.id = root;
    this.description = path.dirname(root);
    this.iconPath = new vscode.ThemeIcon('repo');
    this.contextValue = 'repo';
  }
}

const GROUPS: Record<GroupKind, { label: string; icon: string; expanded: boolean }> = {
  recent: { label: 'Recent branches', icon: 'history', expanded: true },
  branches: { label: 'Branches', icon: 'git-branch', expanded: false },
  stashes: { label: 'Stashes', icon: 'archive', expanded: true },
};

export class GroupNode extends vscode.TreeItem {
  readonly kind = 'group';
  constructor(
    readonly root: string,
    readonly group: GroupKind,
    count: number,
  ) {
    const g = GROUPS[group];
    super(
      g.label,
      count === 0
        ? vscode.TreeItemCollapsibleState.None
        : g.expanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
    );
    this.id = `${root}#${group}`;
    this.description = String(count);
    this.iconPath = new vscode.ThemeIcon(g.icon);
    this.contextValue = `group.${group}`;
  }
}

export class BranchNode extends vscode.TreeItem {
  readonly kind = 'branch';
  constructor(
    readonly root: string,
    readonly name: string,
    branch: Branch | undefined,
    recent: RecentBranch | undefined,
  ) {
    super(name, vscode.TreeItemCollapsibleState.None);
    this.id = `${root}#${recent ? 'r' : 'b'}#${name}`;
    const current = branch?.current ?? false;
    this.contextValue = current ? 'branch.current' : recent ? 'recent' : 'branch';
    this.iconPath = new vscode.ThemeIcon(current ? 'check' : 'git-branch');

    const time = recent?.time ?? branch?.time ?? 0;
    this.description = [current && 'current', branch?.track, time && relativeTime(time)].filter(Boolean).join(' · ');

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${name}**`);
    if (branch?.upstream) tooltip.appendText(` → ${branch.upstream} ${branch.track}`);
    if (recent) tooltip.appendText(`\n\nUsed ${relativeTime(recent.time)}`);
    if (branch) tooltip.appendText(`\n\nLast commit ${relativeTime(branch.time)}: ${branch.subject}`);
    this.tooltip = tooltip;
  }
}

export class StashNode extends vscode.TreeItem {
  readonly kind = 'stash';
  constructor(
    readonly root: string,
    readonly stash: Stash,
  ) {
    super(stash.message || stash.ref, vscode.TreeItemCollapsibleState.None);
    this.id = `${root}#s#${stash.sha}`;
    this.contextValue = 'stash';
    this.iconPath = new vscode.ThemeIcon('git-stash');
    this.description = [stash.branch, relativeTime(stash.time)].filter(Boolean).join(' · ');
    this.tooltip = `${stash.ref}${stash.branch ? ` (on ${stash.branch})` : ''}\n${stash.message}`;
    this.command = { command: 'gitOeil.stashShow', title: 'Show stash content', arguments: [this] };
  }
}

export class RefsProvider implements vscode.TreeDataProvider<Node> {
  private readonly changed = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly data = new Map<string, Promise<RepoData>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly repos: () => string[],
    private readonly log: (msg: string) => void,
  ) {}

  refresh(): void {
    clearTimeout(this.timer);
    this.data.clear();
    this.changed.fire(undefined);
  }

  /** Debounced refresh (vscode.git events come in bursts). */
  refreshSoon(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.refresh(), 300);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.changed.dispose();
  }

  getTreeItem(node: Node): vscode.TreeItem {
    return node;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      const roots = this.repos();
      if (roots.length === 1) return this.groups(roots[0]);
      return roots.map((r) => new RepoNode(r));
    }
    if (node instanceof RepoNode) return this.groups(node.root);
    if (!(node instanceof GroupNode)) return [];

    const data = await this.load(node.root);
    const byName = new Map(data.branches.map((b) => [b.name, b]));
    switch (node.group) {
      case 'recent':
        return data.recent.map((r) => new BranchNode(node.root, r.name, byName.get(r.name), r));
      case 'branches':
        return data.branches.map((b) => new BranchNode(node.root, b.name, b, undefined));
      case 'stashes':
        return data.stashes.map((s) => new StashNode(node.root, s));
    }
  }

  private async groups(root: string): Promise<Node[]> {
    const data = await this.load(root);
    const groups = [
      new GroupNode(root, 'stashes', data.stashes.length),
      new GroupNode(root, 'branches', data.branches.length),
    ];
    if (this.recentCount() > 0) groups.unshift(new GroupNode(root, 'recent', data.recent.length));
    return groups;
  }

  private recentCount(): number {
    return vscode.workspace.getConfiguration('gitOeil.recentBranches').get('count', 10);
  }

  private load(root: string): Promise<RepoData> {
    let data = this.data.get(root);
    if (!data) {
      data = this.fetch(root);
      this.data.set(root, data);
    }
    return data;
  }

  private async fetch(root: string): Promise<RepoData> {
    const quiet = (p: Promise<string>, what: string) =>
      p.catch((e: Error) => {
        this.log(`${what} (${root}): ${e.message}`);
        return '';
      });
    const [branchesOut, stashesOut, reflogOut] = await Promise.all([
      quiet(git(root, ['for-each-ref', '--sort=-committerdate', `--format=${BRANCH_FORMAT}`, 'refs/heads']), 'branches'),
      quiet(git(root, ['stash', 'list', `--format=${STASH_FORMAT}`]), 'stashes'),
      // A repository without commits has no reflog: expected error, not logged.
      git(root, ['reflog', 'show', '--date=unix', `--format=${REFLOG_FORMAT}`, '-n', '2000', 'HEAD']).catch(() => ''),
    ]);
    const branches = parseBranches(branchesOut);
    // Current branch first.
    branches.sort((a, b) => Number(b.current) - Number(a.current));
    const current = branches.find((b) => b.current)?.name;
    const names = new Set(branches.map((b) => b.name));
    return {
      branches,
      stashes: parseStashes(stashesOut),
      recent: recentBranches(reflogOut, names, current, this.recentCount()),
    };
  }
}
