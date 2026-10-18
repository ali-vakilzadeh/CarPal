// Contract sweep resolvers: platform operations (40 §5, backend/libs).
import type { Resolvers } from '../harness.js';

export const resolvers: Resolvers = {
  'config.client': async (h) => ({ as: await h.anonymous() }),
  'health.get': async () => ({ as: { kind: 'none' } }),
  'jobs.get': async (h) => {
    const as = await h.user();
    return { as, params: { job_id: await h.fx.job(as.user, { status: 'succeeded' }) } };
  },
  'jobs.cancel': async (h) => {
    const as = await h.user();
    return { as, params: { job_id: await h.fx.job(as.user) } };
  },
};
