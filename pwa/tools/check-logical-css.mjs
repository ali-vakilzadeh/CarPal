// Part of `pnpm lint` (P1.T3): stylesheets under src/ use logical properties only (no left/right), so they mirror
// in RTL, and take colours from the tokens (no raw hex or colour functions). ESLint covers class names and inline
// styles; this covers .css files.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const pwaDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const RULES = [
  {
    pattern: /(?:^|[\s;{])(?:margin|padding|border|scroll-margin|scroll-padding)-(?:left|right)(?:-[a-z]+)?\s*:/,
    message: 'use *-inline-start / *-inline-end',
  },
  { pattern: /(?:^|[\s;{])(?:left|right)\s*:/, message: 'use inset-inline-start / inset-inline-end' },
  { pattern: /border-(?:top|bottom)-(?:left|right)-radius\s*:/, message: 'use border-start-start-radius …' },
  { pattern: /(?:text-align|float|clear)\s*:\s*(?:left|right)\b/, message: 'use start / end' },
  { pattern: /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/, message: 'take colours from the design-system tokens (var(--…))' },
];

/** Problems in one stylesheet, ignoring comments. */
export function checkCss(text) {
  const problems = [];
  const lines = text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ' ')).split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) if (rule.pattern.test(line)) problems.push({ line: i + 1, text: line.trim(), message: rule.message });
  });
  return problems;
}

function cssFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return cssFiles(full);
    return e.name.endsWith('.css') ? [full] : [];
  });
}

function main() {
  let count = 0;
  for (const file of cssFiles(join(pwaDir, 'src'))) {
    for (const p of checkCss(readFileSync(file, 'utf8'))) {
      console.error(`${relative(pwaDir, file)}:${p.line}  ${p.message}\n    ${p.text}`);
      count++;
    }
  }
  if (count > 0) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
