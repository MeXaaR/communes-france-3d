import { execFileSync } from 'node:child_process';
import { access, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (args, cwd = root) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
await access(join(root, 'dist/index.html'));
const remote = git(['remote', 'get-url', 'origin']);
const author = git(['config', 'user.name']);
const email = git(['config', 'user.email']);
const revision = git(['rev-parse', '--short', 'HEAD']);
const existing = git(['ls-remote', '--heads', remote, 'gh-pages']);
const directory = await mkdtemp(join(tmpdir(), 'communes-pages-'));
try {
  git(['init', '-b', 'gh-pages'], directory);
  git(['config', 'user.name', author], directory);
  git(['config', 'user.email', email], directory);
  git(['remote', 'add', 'origin', remote], directory);
  if (existing) {
    git(['fetch', '--depth=1', 'origin', 'gh-pages'], directory);
    git(['reset', '--mixed', 'FETCH_HEAD'], directory);
  }
  await cp(join(root, 'dist'), directory, { recursive: true });
  await writeFile(join(directory, '.nojekyll'), '');
  git(['add', '--all'], directory);
  if (!git(['status', '--porcelain'], directory)) {
    console.log('La version publiée est déjà à jour.');
  } else {
    git(['commit', '-m', `Publish application from ${revision}`], directory);
    git(['push', 'origin', 'HEAD:gh-pages'], directory);
    console.log('Version publiée sur gh-pages. GitHub Pages prépare sa mise en ligne.');
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
