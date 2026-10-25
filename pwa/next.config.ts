import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const pwaDir = dirname(fileURLToPath(import.meta.url));

// The linked packages (@carpal/api-contracts, @carpal/i18n) live in ../shared and ship TypeScript sources.
// Turbopack keeps pwa/ as its root and follows the pnpm links into ../shared through an additional root, instead
// of widening the root to the repository (which would also watch backend/, including its database files).
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@carpal/api-contracts', '@carpal/i18n'],
  turbopack: { root: pwaDir },
  // The root layout is app/[locale]/layout.tsx, so unmatched URLs get their own document (app/global-not-found.tsx).
  experimental: {
    globalNotFound: true,
    turbopackAdditionalRoots: {
      shared: { path: join(pwaDir, '..', 'shared') },
    },
  },
};

export default nextConfig;
