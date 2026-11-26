// Lint configuration of @carpal/business-ui: the rules of pwa/ (provider plan PRV-GD-08). Run by pwa `pnpm lint`
// (pwa/tools/lint-business-ui.mjs); the plugins resolve from pwa/node_modules through that file's own imports.
import pwa from '../../pwa/eslint.config.js';

// No Next.js pages here: the pages-directory rule of the Next.js preset does not apply.
export default [...pwa, { rules: { '@next/next/no-html-link-for-pages': 'off' } }];
