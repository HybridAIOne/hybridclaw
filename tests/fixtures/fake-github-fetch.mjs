// Preloaded with `node --import` in e2e containers that must not reach
// GitHub. Serves the GitHub contents API and raw downloads from the directory
// tree at HYBRIDCLAW_E2E_FAKE_GITHUB_ROOT (<owner>/<repo>/<path>, branch
// `main`) and passes every other request to the real fetch.
import fs from 'node:fs';
import path from 'node:path';

const root = process.env.HYBRIDCLAW_E2E_FAKE_GITHUB_ROOT;
const realFetch = globalThis.fetch;

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function contentsEntry(owner, repo, repoPath) {
  const stat = fs.statSync(path.join(root, owner, repo, repoPath));
  return {
    type: stat.isDirectory() ? 'dir' : 'file',
    name: path.posix.basename(repoPath),
    path: repoPath,
    size: stat.isDirectory() ? 0 : stat.size,
    download_url: stat.isDirectory()
      ? null
      : `https://raw.githubusercontent.com/${owner}/${repo}/main/${repoPath}`,
  };
}

function serveApi(url) {
  const [, repos, owner, repo, kind, ...rest] = url.pathname.split('/');
  if (repos !== 'repos' || !owner || !repo) return json(404, {});
  if (!fs.existsSync(path.join(root, owner, repo))) {
    return json(404, { message: 'Not Found' });
  }
  if (!kind) return json(200, { default_branch: 'main' });
  const repoPath = rest.map(decodeURIComponent).join('/');
  const target = path.join(root, owner, repo, repoPath);
  if (kind !== 'contents' || !fs.existsSync(target)) {
    return json(404, { message: 'Not Found' });
  }
  if (!fs.statSync(target).isDirectory()) {
    return json(200, contentsEntry(owner, repo, repoPath));
  }
  return json(
    200,
    fs
      .readdirSync(target)
      .map((name) =>
        contentsEntry(owner, repo, path.posix.join(repoPath, name)),
      ),
  );
}

function serveRaw(url) {
  const [, owner, repo, , ...rest] = url.pathname.split('/');
  const target = path.join(root, owner, repo, ...rest);
  return fs.existsSync(target)
    ? new Response(fs.readFileSync(target))
    : new Response('Not Found', { status: 404 });
}

globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname === 'api.github.com') return serveApi(url);
  if (url.hostname === 'raw.githubusercontent.com') return serveRaw(url);
  return realFetch(input, init);
};
