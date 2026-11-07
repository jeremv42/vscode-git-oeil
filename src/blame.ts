import * as vscode from 'vscode';
import * as path from 'node:path';
import { git } from './git';
import { parseBlamePorcelain, UNCOMMITTED_SHA, type Blame, type CommitInfo } from './lib/parse';
import { relativeTime } from './lib/time';

const MAX_SUMMARY = 80;

interface CacheEntry {
  version: number;
  abort: AbortController;
  blame: Promise<Blame | null>; // null : fichier hors dépôt, non suivi, binaire…
}

/** Blame de la ligne courante en fin de ligne, à la GitLens. */
export class BlameController implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: {
      color: new vscode.ThemeColor('gitOeil.blameForeground'),
      margin: '0 0 0 3em',
      fontStyle: 'italic',
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly cache = new Map<string, CacheEntry>();
  private readonly userEmails = new Map<string, Promise<string>>();
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;
  private enabled = true;
  private delayMs = 150;

  constructor(private readonly log: (msg: string) => void) {
    this.readSettings();
    this.disposables.push(
      this.decoration,
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (e.textEditor === vscode.window.activeTextEditor) this.schedule();
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (editor?.document === e.document && e.contentChanges.length > 0) {
          editor.setDecorations(this.decoration, []);
          this.schedule();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.forget(doc.uri.toString())),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitOeil.blame')) {
          this.readSettings();
          this.schedule();
        }
      }),
    );
    this.schedule();
  }

  /** À appeler quand un dépôt change (commit, checkout…) : les blames en cache sont périmés. */
  invalidate(): void {
    for (const key of [...this.cache.keys()]) this.forget(key);
    this.schedule();
  }

  dispose(): void {
    clearTimeout(this.timer);
    for (const key of [...this.cache.keys()]) this.forget(key);
    for (const d of this.disposables) d.dispose();
  }

  private readSettings(): void {
    const cfg = vscode.workspace.getConfiguration('gitOeil.blame');
    this.enabled = cfg.get('enabled', true);
    this.delayMs = cfg.get('delayMs', 150);
  }

  private forget(key: string): void {
    this.cache.get(key)?.abort.abort();
    this.cache.delete(key);
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), this.delayMs);
  }

  private async update(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    if (!this.enabled || doc.uri.scheme !== 'file') {
      editor.setDecorations(this.decoration, []);
      return;
    }
    const version = doc.version;
    const blame = await this.blame(doc);
    // L'éditeur a pu changer pendant l'appel à git.
    if (vscode.window.activeTextEditor !== editor || doc.version !== version) return;
    if (!blame) {
      editor.setDecorations(this.decoration, []);
      return;
    }

    const dir = path.dirname(doc.uri.fsPath);
    const userEmail = await this.userEmail(dir);
    const lines = [...new Set(editor.selections.map((s) => s.active.line))];
    const options: vscode.DecorationOptions[] = [];
    for (const line of lines) {
      const commit = blame.commits.get(blame.lines[line]);
      if (!commit || line >= doc.lineCount) continue;
      const end = doc.lineAt(line).range.end;
      options.push({
        range: new vscode.Range(end, end),
        renderOptions: { after: { contentText: blameText(commit, userEmail) } },
        hoverMessage: blameHover(commit, dir, userEmail),
      });
    }
    editor.setDecorations(this.decoration, options);
  }

  /** Blame du contenu actuel de l'éditeur (modifications non enregistrées comprises). */
  private blame(doc: vscode.TextDocument): Promise<Blame | null> {
    const key = doc.uri.toString();
    const cached = this.cache.get(key);
    if (cached?.version === doc.version) return cached.blame;
    cached?.abort.abort();

    const abort = new AbortController();
    const file = doc.uri.fsPath;
    const blame = git(path.dirname(file), ['blame', '--porcelain', '--contents', '-', '--', path.basename(file)], {
      input: doc.getText(),
      signal: abort.signal,
    }).then(parseBlamePorcelain, (e: Error) => {
      if (!abort.signal.aborted) this.log(`blame ${file} : ${e.message.split('\n')[0]}`);
      return null;
    });
    this.cache.set(key, { version: doc.version, abort, blame });
    return blame;
  }

  private userEmail(dir: string): Promise<string> {
    let email = this.userEmails.get(dir);
    if (!email) {
      email = git(dir, ['config', 'user.email']).then(
        (out) => out.trim(),
        () => '',
      );
      this.userEmails.set(dir, email);
    }
    return email;
  }
}

function authorName(commit: CommitInfo, userEmail: string): string {
  if (commit.sha === UNCOMMITTED_SHA) return 'Vous';
  return userEmail && commit.authorMail === userEmail ? 'Vous' : commit.author;
}

function blameText(commit: CommitInfo, userEmail: string): string {
  if (commit.sha === UNCOMMITTED_SHA) return 'Vous • Modification non commitée';
  let summary = commit.summary;
  if (summary.length > MAX_SUMMARY) summary = summary.slice(0, MAX_SUMMARY - 1) + '…';
  return `${authorName(commit, userEmail)}, ${relativeTime(commit.authorTime)} • ${summary}`;
}

function blameHover(commit: CommitInfo, cwd: string, userEmail: string): vscode.MarkdownString | undefined {
  if (commit.sha === UNCOMMITTED_SHA) return undefined;
  const md = new vscode.MarkdownString();
  md.isTrusted = { enabledCommands: ['gitOeil.showCommit'] };
  const date = new Date(commit.authorTime * 1000).toLocaleString();
  const args = encodeURIComponent(JSON.stringify([{ cwd, sha: commit.sha }]));
  md.appendMarkdown(`**${escape(authorName(commit, userEmail))}** `);
  md.appendText(`<${commit.authorMail}>`);
  md.appendMarkdown(`, ${relativeTime(commit.authorTime)} (${escape(date)})\n\n`);
  md.appendText(commit.summary);
  md.appendMarkdown(`\n\n---\n\n[$(git-commit) ${commit.sha.slice(0, 8)}](command:gitOeil.showCommit?${args} "Voir le commit")`);
  md.supportThemeIcons = true;
  return md;
}

function escape(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, '\\$&');
}
