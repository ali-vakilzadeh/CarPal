import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// findBy*/waitFor wait up to 5 s instead of 1 s: whole screens with several reads pass in well under a second alone
// but not always within 1 s when every worker is busy (P9; the P8 testTimeout note in vitest.config.ts).
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => cleanup());
