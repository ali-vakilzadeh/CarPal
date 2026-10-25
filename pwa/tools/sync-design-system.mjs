// Design-system sync (GD-11). Docs/carpal-design-system/ is the source of truth.
//   node tools/sync-design-system.mjs           copy the web files into shared/design-system/web/
//   node tools/sync-design-system.mjs --check   exit 1 when shared/design-system/web/ differs from Docs (CI)
//   node tools/sync-design-system.mjs --public  copy shared/design-system/web/ into pwa/public/ds/ (gitignored),
//                                               so tokens.css, bundle.css and the fonts are served at stable URLs
//                                               (/ds/...) that the layout can preload; run by `pnpm dev` / `pnpm build`.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pwaDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = join(pwaDir, '..');

export const DEFAULT_PATHS = {
  source: join(repoDir, 'Docs', 'carpal-design-system'),
  shared: join(repoDir, 'shared', 'design-system', 'web'),
  public: join(pwaDir, 'public', 'ds'),
};

/** Files the web apps use, relative to the design-system folder (fonts are added from fonts/). */
const WEB_FILES = ['tokens.css', 'tokens.json', 'components/bundle.css'];
/** Files the browser loads (served from public/ds). */
const PUBLIC_FILES = ['tokens.css', 'components/bundle.css'];

function fontFiles(dir) {
  const fonts = join(dir, 'fonts');
  if (!existsSync(fonts)) return [];
  return readdirSync(fonts)
    .filter((f) => f.endsWith('.woff2') || f.startsWith('LICENSE'))
    .sort()
    .map((f) => `fonts/${f}`);
}

/** The relative paths synced from the source design-system folder. */
export function webFileList(sourceDir) {
  return [...WEB_FILES, ...fontFiles(sourceDir)];
}

function copyAll(fromDir, toDir, files) {
  for (const f of files) {
    const target = join(toDir, f);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(fromDir, f), target);
  }
}

/** Lists target files that are missing, different, or no longer in the source. */
export function staleFiles(fromDir, toDir, files) {
  const stale = [];
  for (const f of files) {
    const target = join(toDir, f);
    if (!existsSync(target) || !readFileSync(target).equals(readFileSync(join(fromDir, f)))) stale.push(f);
  }
  const expected = new Set(files);
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const rel = relative(toDir, full).replace(/\\/g, '/');
        if (rel !== 'README.md' && !expected.has(rel)) stale.push(`${rel} (extra)`);
      }
    }
  };
  walk(toDir);
  return stale;
}

export function syncDesignSystem({ source, shared }) {
  const files = webFileList(source);
  const extras = staleFiles(source, shared, files).filter((f) => f.endsWith(' (extra)'));
  for (const extra of extras) rmSync(join(shared, extra.replace(/ \(extra\)$/, '')));
  copyAll(source, shared, files);
  return files;
}

export function publishDesignSystem({ shared, public: publicDir }) {
  const files = [...PUBLIC_FILES, ...fontFiles(shared).filter((f) => f.endsWith('.woff2'))];
  rmSync(publicDir, { recursive: true, force: true });
  copyAll(shared, publicDir, files);
  return files;
}

function main(argv) {
  const paths = DEFAULT_PATHS;
  if (argv.includes('--check')) {
    const stale = staleFiles(paths.source, paths.shared, webFileList(paths.source));
    if (stale.length > 0) {
      console.error(`shared/design-system/web is out of date with Docs/carpal-design-system:\n  ${stale.join('\n  ')}\nRun: pnpm ds:sync`);
      process.exit(1);
    }
    console.log('shared/design-system/web is up to date.');
    return;
  }
  if (argv.includes('--public')) {
    const files = publishDesignSystem(paths);
    console.log(`Published ${files.length} design-system files to public/ds.`);
    return;
  }
  const files = syncDesignSystem(paths);
  console.log(`Synced ${files.length} files into shared/design-system/web.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
