import * as vscode from 'vscode';
import { BlameController } from './blame';
import { getGitAPI, git, GitContentProvider, GitError, SCHEME, setGitPath, showGitOutput, type GitAPI } from './git';
import { BranchNode, RefsProvider, StashNode, type Node } from './refsView';

// Extension « workspace » : en Remote (SSH, WSL, conteneur), elle tourne là où sont
// les dépôts et le binaire git.

let output: vscode.OutputChannel;

function log(message: string): void {
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  output = vscode.window.createOutputChannel('Git Œil');
  context.subscriptions.push(output);

  const api = await getGitAPI();
  setGitPath(api?.git.path);
  if (!api) log("Extension vscode.git indisponible : dépôts détectés depuis les dossiers de l'espace de travail, sans rafraîchissement automatique.");

  let fallbackRepos: string[] = [];
  const repos = (): string[] =>
    api ? api.repositories.map((r) => r.rootUri.fsPath).sort() : fallbackRepos;

  const blame = new BlameController(log);
  const refs = new RefsProvider(repos, log);
  const view = vscode.window.createTreeView('gitOeil.refs', { treeDataProvider: refs });
  const updateMessage = () => {
    view.message = repos().length === 0 ? 'Aucun dépôt git ouvert.' : undefined;
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
    return vscode.window.showQuickPick(roots, { placeHolder: 'Dépôt' });
  };

  const showError = (args: string[], e: unknown) => {
    const message = e instanceof GitError ? e.stderr.trim() || e.message : String(e);
    log(`échec : ${message}`);
    vscode.window.showErrorMessage(`git ${args[0]} : ${message}`, 'Voir le journal').then((choice) => {
      if (choice) output.show();
    });
  };

  /** Lance une commande git qui modifie le dépôt, affiche l'erreur éventuelle, rafraîchit. */
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

  /** Les index stash@{n} bougent : on vérifie que l'entrée pointe toujours sur le même stash. */
  const checkStash = async (node: StashNode): Promise<boolean> => {
    const sha = await git(node.root, ['rev-parse', node.stash.ref]).then((s) => s.trim(), () => '');
    if (sha === node.stash.sha) return true;
    vscode.window.showWarningMessage('La liste des stashs a changé, elle vient d’être rafraîchie.');
    refs.refresh();
    return false;
  };

  const stashPush = async (node: Node | undefined, untracked: boolean) => {
    const root = await pickRepo(node);
    if (!root) return;
    const message = await vscode.window.showInputBox({
      prompt: untracked ? 'Message du stash (fichiers non suivis inclus)' : 'Message du stash',
      placeHolder: 'Optionnel',
    });
    if (message === undefined) return;
    const args = ['stash', 'push'];
    if (untracked) args.push('--include-untracked');
    if (message.trim()) args.push('-m', message.trim());
    await run(root, args, 'Modifications mises de côté');
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
      run(node.root, ['switch', node.name], `Sur la branche ${node.name}`),
    ),
    vscode.commands.registerCommand('gitOeil.branchDelete', async (node: BranchNode) => {
      const ok = await vscode.window.showWarningMessage(
        `Supprimer la branche « ${node.name} » ?`,
        { modal: true },
        'Supprimer',
      );
      if (!ok) return;
      const args = ['branch', '-d', node.name];
      try {
        log(`git ${args.join(' ')} (${node.root})`);
        await git(node.root, args);
        vscode.window.setStatusBarMessage(`Branche ${node.name} supprimée`, 4000);
        refs.refresh();
        return;
      } catch (e) {
        // -d refuse une branche non fusionnée : on propose -D, sinon on affiche l'erreur.
        if (!(e instanceof GitError && /not fully merged/.test(e.stderr))) {
          showError(args, e);
          return;
        }
      }
      const force = await vscode.window.showWarningMessage(
        `La branche « ${node.name} » n'est pas fusionnée. Ses commits seront perdus s'ils ne sont sur aucune autre branche.`,
        { modal: true },
        'Supprimer quand même',
      );
      if (force) await run(node.root, ['branch', '-D', node.name], `Branche ${node.name} supprimée`);
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
      // apply n'exige pas une référence stash@{n} : le sha évite toute ambiguïté.
      run(node.root, ['stash', 'apply', node.stash.sha], 'Stash appliqué'),
    ),
    vscode.commands.registerCommand('gitOeil.stashPop', async (node: StashNode) => {
      if (await checkStash(node)) await run(node.root, ['stash', 'pop', node.stash.ref], 'Stash appliqué et supprimé');
    }),
    vscode.commands.registerCommand('gitOeil.stashDrop', async (node: StashNode) => {
      const ok = await vscode.window.showWarningMessage(
        `Supprimer le stash « ${node.stash.message || node.stash.ref} » ?`,
        { modal: true, detail: 'Son contenu ne sera plus accessible.' },
        'Supprimer',
      );
      if (ok && (await checkStash(node))) await run(node.root, ['stash', 'drop', node.stash.ref], 'Stash supprimé');
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
