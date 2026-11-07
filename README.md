# Git Œil

A minimal VS Code extension around git:

- **Inline blame**: at the end of the current line, `Author, 3 days ago • commit message`
  ("You" for your own commits and for uncommitted lines). Hovering shows the details, with
  a link to open the commit in the editor (`git show`) and, when `origin` is on GitHub or
  GitLab (gitlab.com or self-hosted), a link to the commit on the website. Unsaved changes
  are taken into account (`git blame --contents -`).
- **"Stashes & Branches" view** in the Source Control tab:
  - **Recent branches**: the last branches you switched to, read from the `HEAD` reflog;
    the ✓ button switches back to one.
  - **Branches**: local branches (current one first), with ahead/behind against upstream;
    switch (`git switch`), delete (right click, `-d` then `-D` after confirmation).
  - **Stashes**: click to see the content; apply / pop / drop buttons; title bar button to
    create a stash ("…" menu: include untracked files).

This is a `workspace` extension: with Remote SSH / WSL / Containers it is installed and runs
on the remote side, where the repositories are. It relies on the built-in `vscode.git`
extension to know which repositories are open and to refresh, and calls `git` directly for
everything else.

## Installation

```sh
npm install              # TypeScript 7 + types (dev)
npm run package          # compiles (out/) then builds git-oeil-0.1.0.vsix
code --install-extension git-oeil-0.1.0.vsix
```

In a Remote window, use "Extensions: Install from VSIX…": VS Code installs it on the remote.

## Development

TypeScript (`src/`, tests in `test/`) compiled with TypeScript 7 into `out/`
(`npm run compile`, or `npm run watch`). No runtime dependencies.
VS Code 1.145 minimum, Node 24 types. Tests: `npm test` (parsing is also checked against a
real temporary git repository).

## Settings

```jsonc
{
  "gitOeil.blame.enabled": true,       // also: "Git Œil: Toggle Inline Blame" command
  "gitOeil.blame.delayMs": 150,        // delay after a cursor move
  "gitOeil.recentBranches.count": 10   // 0 hides the "Recent branches" group
}
```

Blame color: `workbench.colorCustomizations` → `"gitOeil.blameForeground"`.

## Notes

- Command errors (conflict on `stash pop`, local changes preventing a branch switch…) are
  shown in a notification with git's message, with details in the "Git Œil" output channel.
- If GitLens is installed, disable its current line blame to avoid two blames
  (`gitlens.currentLine.enabled: false`).
