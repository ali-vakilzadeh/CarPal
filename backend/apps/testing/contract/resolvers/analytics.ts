// Contract sweep resolvers: product analytics and audit (40 §22, §23.5).
import type { Resolvers } from '../harness.js';

const day = () => new Date().toISOString().slice(0, 10);

export const resolvers: Resolvers = {
  'events.ingest': async (h) => ({
    as: await h.anonymous(),
    body: {
      platform: 'android',
      app_version: '1.0.0',
      events: [{ event_name: 'app.opened', schema_version: 1, occurred_at: new Date().toISOString(), properties: { cold_start: true } }],
    },
  }),
  'admin.audit_search': async (h) => ({
    as: await h.staff('platform_admin'),
    body: { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date().toISOString(), action: 'audit.searched', limit: 10 },
  }),
  'admin.analytics_dashboard': async (h) => ({
    as: await h.staff('platform_support'),
    params: { dashboard_key: 'growth' },
    query: { from: day(), to: day() },
  }),
};
