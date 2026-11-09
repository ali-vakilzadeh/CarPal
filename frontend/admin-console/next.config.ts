import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const appDir = dirname(fileURLToPath(import.meta.url));
const repoDir = join(appDir, '..', '..');

// Copied from pwa/next.config.ts (GD-01). The linked packages (@carpal/api-contracts, @carpal/i18n,
// @carpal/region-config) live in ../../shared and ship TypeScript sources; Turbopack keeps this app as its root and
// follows the pnpm links into shared/ through an additional root, instead of widening the root to the repository.
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@carpal/api-contracts', '@carpal/i18n', '@carpal/region-config'],
  turbopack: { root: appDir },
  // authInterrupts: forbidden() renders the no-permission page with status 403 (AC1.T5, AC4.T6).
  experimental: {
    authInterrupts: true,
    turbopackAdditionalRoots: {
      shared: { path: join(repoDir, 'shared') },
    },
  },
};

export default nextConfig;
