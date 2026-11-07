import * as vscode from 'vscode';
import { execFile } from 'node:child_process';

// Minimal subset of the built-in vscode.git extension API (extensions/git/src/api/git.d.ts).
// Used to know which repositories are open and to be notified when they change;
// the data itself is read by calling git directly.
export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD: { readonly name?: string } | undefined;
    readonly onDidChange: vscode.Event<void>;
  };
}

export interface GitAPI {
  readonly git: { readonly path: string };
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}

/** vscode.git API, or undefined if the extension is disabled. */
export async function getGitAPI(): Promise<GitAPI | undefined> {
  try {
    const ext = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>('vscode.git');
    if (!ext) return undefined;
    const exports = ext.isActive ? ext.exports : await ext.activate();
    return exports.getAPI(1);
  } catch {
    return undefined;
  }
}

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly code: number | string | null | undefined,
  ) {
    super(stderr.trim() || `git ${args[0]} failed (code ${code})`);
  }
}

let gitPath = 'git';

export function setGitPath(path: string | undefined): void {
  if (path) gitPath = path;
}

export interface GitOptions {
  /** Written to stdin. */
  input?: string;
  signal?: AbortSignal;
}

export function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      gitPath,
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        signal: opts.signal,
        // No index lock for reads (same setting as vscode.git).
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout, stderr) => {
        if (err) reject(new GitError(args, stderr, (err as NodeJS.ErrnoException).code));
        else resolve(stdout);
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

// Read-only documents (stash content, commit): git-oeil:/<title>.diff?<json>
export const SCHEME = 'git-oeil';

export class GitContentProvider implements vscode.TextDocumentContentProvider {
  provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { cwd, args } = JSON.parse(uri.query) as { cwd: string; args: string[] };
    return git(cwd, args).catch((e: Error) => e.message);
  }
}

/** Opens the output of `git <args>` in a read-only editor. */
export async function showGitOutput(cwd: string, title: string, args: string[]): Promise<void> {
  const uri = vscode.Uri.from({ scheme: SCHEME, path: `/${title}.diff`, query: JSON.stringify({ cwd, args }) });
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc, { preview: true });
}
