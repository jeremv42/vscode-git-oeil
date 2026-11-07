// Turns a git remote URL into a web link for GitHub or GitLab (gitlab.com or self-hosted).

export interface RemoteWeb {
  provider: 'GitHub' | 'GitLab';
  /** e.g. https://github.com/owner/repo */
  repoUrl: string;
}

/**
 * Supported forms:
 *   git@github.com:owner/repo.git
 *   ssh://git@gitlab.example.com:2222/group/sub/repo.git
 *   https://github.com/owner/repo(.git)
 * Returns null for any other host.
 */
export function parseRemoteUrl(url: string): RemoteWeb | null {
  url = url.trim();
  let host: string;
  let repoPath: string;
  let webPort = '';

  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/.exec(url);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    host = scp[1];
    repoPath = scp[2];
  } else {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    host = parsed.hostname;
    repoPath = parsed.pathname;
    // The port of an ssh/git URL is not the web port; an http(s) one is.
    if (/^https?:$/.test(parsed.protocol) && parsed.port) webPort = `:${parsed.port}`;
  }

  repoPath = repoPath.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!repoPath.includes('/')) return null;
  host = host.toLowerCase();

  let provider: RemoteWeb['provider'];
  if (host.includes('github')) {
    provider = 'GitHub';
    // ssh.github.com, or ssh config aliases like github.com-work
    if (/(^|\.)github\.com/.test(host)) host = 'github.com';
  } else if (host.includes('gitlab')) {
    provider = 'GitLab';
    if (/(^|\.)gitlab\.com/.test(host)) host = 'gitlab.com';
  } else {
    return null;
  }
  return { provider, repoUrl: `https://${host}${webPort}/${repoPath}` };
}

export function commitUrl(remote: RemoteWeb, sha: string): string {
  return remote.provider === 'GitLab' ? `${remote.repoUrl}/-/commit/${sha}` : `${remote.repoUrl}/commit/${sha}`;
}
