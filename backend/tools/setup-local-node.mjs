#!/usr/bin/env node
// Installs a project-local Node.js (gitignored) under backend/.tools/node so the
// backend can use a newer Node than the system one. Downloads the official build
// from nodejs.org and verifies it against the published SHASUMS256.txt.
//
//   node tools/setup-local-node.mjs            # version from backend/.node-version
//   node tools/setup-local-node.mjs 24.21.0
//
// Then put it first on PATH:  source tools/use-local-node.sh   (Git Bash)
//                             . tools/use-local-node.ps1       (PowerShell)
// Plain .mjs on purpose: it must run on the old system Node.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const toolsDir = join(backendDir, '.tools');
const targetDir = join(toolsDir, 'node');

const version = (process.argv[2] ?? readFileSync(join(backendDir, '.node-version'), 'utf8')).trim().replace(/^v/, '');
const platform = { win32: 'win', darwin: 'darwin', linux: 'linux' }[process.platform];
const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
if (!platform || !arch) throw new Error(`Unsupported platform ${process.platform}/${process.arch}`);
const ext = platform === 'win' ? 'zip' : 'tar.gz';
const base = `node-v${version}-${platform}-${arch}`;
const url = `https://nodejs.org/dist/v${version}/${base}.${ext}`;

const versionFile = join(targetDir, '.version');
if (existsSync(versionFile) && readFileSync(versionFile, 'utf8').trim() === version) {
  console.log(`Local Node ${version} already installed at ${targetDir}`);
  process.exit(0);
}

async function download(u) {
  const res = await fetch(u);
  if (!res.ok) throw new Error(`GET ${u} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

console.log(`Downloading ${url}`);
const [archive, sums] = await Promise.all([
  download(url),
  download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`).then((b) => b.toString('utf8')),
]);
const expected = sums
  .split('\n')
  .map((l) => l.trim().split(/\s+/))
  .find(([, f]) => f === `${base}.${ext}`)?.[0];
const actual = createHash('sha256').update(archive).digest('hex');
if (!expected || expected !== actual) throw new Error(`Checksum mismatch for ${base}.${ext}: expected ${expected}, got ${actual}`);
console.log(`Checksum OK (${actual})`);

mkdirSync(toolsDir, { recursive: true });
const archivePath = join(toolsDir, `${base}.${ext}`);
writeFileSync(archivePath, archive);
rmSync(join(toolsDir, base), { recursive: true, force: true });
// bsdtar ships with Windows 10+ and every Unix; it extracts zip and tar.gz alike.
// On Windows call it by full path: a GNU tar from Git Bash earlier on PATH cannot
// read zip files. Relative names avoid "C:" being parsed as a remote host.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
execFileSync(tar, ['-xf', `${base}.${ext}`], { cwd: toolsDir, stdio: 'inherit' });
rmSync(targetDir, { recursive: true, force: true });
renameSync(join(toolsDir, base), targetDir);
rmSync(archivePath);
writeFileSync(versionFile, version + '\n');
console.log(`Installed Node ${version} at ${targetDir}`);
