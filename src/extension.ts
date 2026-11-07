import * as vscode from 'vscode';
import { BlameController } from './blame';
import { getGitAPI, git, GitContentProvider, GitError, SCHEME, setGitPath, showGitOutput, type GitAPI } from './git';
import { BranchNode, RefsProvider, StashNode, type Node } from './refsView';

// "workspace" extension: with Remote (SSH, WSL, containers) it runs where the
// repositories and the git binary are.

let output: vscode.OutputChannel;

function log(message: string): void {
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Git Œil');
  context.subscriptions.push(output);

  const api = await getGitAPI();
  setGitPath(api?.git.path);
  if (!api) log('vscode.git extension unavailable: repositories detected from workspace folders, no automatic refresh.');

  let fallbackRepos: string[] = [];
  const repos = (): string[] =>
    api ? api.repositories.map((r) => r.rootUri.fsPath).sort() : fallbackRepos;

  const blame = new BlameController(log);
  const refs = new RefsProvider(repos, log);
  const view = vscode.window.createTreeView('gitOeil.refs', { treeDataProvider: refs });
  const updateMessage = () => {
    view.message = repos().length === 0 ? 'No open git repository.' : undefined;
  };
  context.subscriptions.push(
    blame,
    refs,
    view,
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new GitContentProvider()),
  );

  if (api) watchRepositories(api, context, () => {
    blame.invalidate();
    refs.refreshSoon();
    updateMessage();
  });
  else {
    fallbackRepos = await discoverRepos();
    refs.refresh();
  }
  updateMessage();

  const pickRepo = async (node?: Node): Promise<string | undefined> => {
    if (node) return node.root;
    const roots = repos();
    if (roots.length <= 1) return roots[0];
    return vscode.window.showQuickPick(roots, { placeHolder: 'Repository' });
  };

  const showError = (args: string[], e: unknown) => {
    const message = e instanceof GitError ? e.stderr.trim() || e.message : String(e);
    log(`failed: ${message}`);
    vscode.window.showErrorMessage(`git ${args[0]}: ${message}`, 'Show log').then((choice) => {
      if (choice) output.show();
    });
  };

  /** Runs a git command that changes the repository, shows any error, refreshes. */
  const run = async (root: string, args: string[], success?: string): Promise<boolean> => {
    try {
      log(`git ${args.join(' ')} (${root})`);
      await vscode.window.withProgress(
        { location: { viewId: 'gitOeil.refs' } },
        () => git(root, args),
      );
      if (success) vscode.window.setStatusBarMessage(success, 4000);
      return true;
    } catch (e) {
      showError(args, e);
      return false;
    } finally {
      refs.refresh();
      blame.invalidate();
    }
  };

  /** stash@{n} indexes shift: check that the entry still points to the same stash. */
  const checkStash = async (node: StashNode): Promise<boolean> => {
    const sha = await git(node.root, ['rev-parse', node.stash.ref]).then((s) => s.trim(), () => '');
    if (sha === node.stash.sha) return true;
    vscode.window.showWarningMessage('The stash list has changed and was refreshed.');
    refs.refresh();
    return false;
  };

  const stashPush = async (node: Node | undefined, untracked: boolean) => {
    const root = await pickRepo(node);
    if (!root) return;
    const message = await vscode.window.showInputBox({
      prompt: untracked ? 'Stash message (untracked files included)' : 'Stash message',
      placeHolder: 'Optional',
    });
    if (message === undefined) return;
    const args = ['stash', 'push'];
    if (untracked) args.push('--include-untracked');
    if (message.trim()) args.push('-m', message.trim());
    await run(root, args, 'Changes stashed');
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('gitOeil.toggleBlame', async () => {
      const cfg = vscode.workspace.getConfiguration('gitOeil.blame');
      await cfg.update('enabled', !cfg.get('enabled', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('gitOeil.refresh', () => {
      refs.refresh();
      blame.invalidate();
    }),

    vscode.commands.registerCommand('gitOeil.checkout', (node: BranchNode) =>
      run(node.root, ['switch', node.name], `Switched to ${node.name}`),
    ),
    vscode.commands.registerCommand('gitOeil.branchDelete', async (node: BranchNode) => {
      const ok = await vscode.window.showWarningMessage(
        `Delete branch "${node.name}"?`,
        { modal: true },
        'Delete',
      );
      if (!ok) return;
      const args = ['branch', '-d', node.name];
      try {
        log(`git ${args.join(' ')} (${node.root})`);
        await git(node.root, args);
        vscode.window.setStatusBarMessage(`Deleted branch ${node.name}`, 4000);
        refs.refresh();
        return;
      } catch (e) {
        // -d refuses an unmerged branch: offer -D, otherwise show the error.
        if (!(e instanceof GitError && /not fully merged/.test(e.stderr))) {
          showError(args, e);
          return;
        }
      }
      const force = await vscode.window.showWarningMessage(
        `Branch "${node.name}" is not fully merged. Its commits will be lost if they are not on another branch.`,
        { modal: true },
        'Delete anyway',
      );
      if (force) await run(node.root, ['branch', '-D', node.name], `Deleted branch ${node.name}`);
    }),

    vscode.commands.registerCommand('gitOeil.stashPush', (node?: Node) => stashPush(node, false)),
    vscode.commands.registerCommand('gitOeil.stashPushUntracked', (node?: Node) => stashPush(node, true)),
    vscode.commands.registerCommand('gitOeil.stashShow', (node: StashNode) =>
      showGitOutput(node.root, `${node.stash.ref} ${node.stash.message}`.replace(/[\\/]/g, '_'), [
        'stash',
        'show',
        '--stat',
        '-p',
        node.stash.sha,
      ]),
    ),
    vscode.commands.registerCommand('gitOeil.stashApply', (node: StashNode) =>
      // apply does not require a stash@{n} reference: the sha avoids any ambiguity.
      run(node.root, ['stash', 'apply', node.stash.sha], 'Stash applied'),
    ),
    vscode.commands.registerCommand('gitOeil.stashPop', async (node: StashNode) => {
      if (await checkStash(node)) await run(node.root, ['stash', 'pop', node.stash.ref], 'Stash applied and dropped');
    }),
    vscode.commands.registerCommand('gitOeil.stashDrop', async (node: StashNode) => {
      const ok = await vscode.window.showWarningMessage(
        `Drop stash "${node.stash.message || node.stash.ref}"?`,
        { modal: true, detail: 'Its content will no longer be accessible.' },
        'Drop',
      );
      if (ok && (await checkStash(node))) await run(node.root, ['stash', 'drop', node.stash.ref], 'Stash dropped');
    }),

    vscode.commands.registerCommand('gitOeil.showCommit', ({ cwd, sha }: { cwd: string; sha: string }) =>
      showGitOutput(cwd, sha.slice(0, 8), ['show', '--stat', '-p', '--format=fuller', sha]),
    ),
  );
}

function watchRepositories(api: GitAPI, context: vscode.ExtensionContext, onChange: () => void): void {
  const watched = new Map<string, vscode.Disposable>();
  const watch = (repo: GitAPI['repositories'][number]) => {
    const key = repo.rootUri.toString();
    if (!watched.has(key)) watched.set(key, repo.state.onDidChange(onChange));
  };
  api.repositories.forEach(watch);
  context.subscriptions.push(
    api.onDidOpenRepository((repo) => {
      watch(repo);
      onChange();
    }),
    api.onDidCloseRepository((repo) => {
      const key = repo.rootUri.toString();
      watched.get(key)?.dispose();
      watched.delete(key);
      onChange();
    }),
    { dispose: () => watched.forEach((d) => d.dispose()) },
  );
}

async function discoverRepos(): Promise<string[]> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const roots = await Promise.all(
    folders.map((f) => git(f.uri.fsPath, ['rev-parse', '--show-toplevel']).then((s) => s.trim(), () => '')),
  );
  return [...new Set(roots.filter(Boolean))].sort();
}

export function deactivate(): void {}
