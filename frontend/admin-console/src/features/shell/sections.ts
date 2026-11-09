// The console's navigation sections (AC4.T3, Docs/23 §3.1, GD-09). A section is visible to a staff member when one of
// their roles may call one of the operations the section is built on (the generated role table, src/lib/roles); the
// server still decides every call. Sections whose screens have no operation in contract 1.3.0 are not listed
// (Featured placements, Notifications & templates, Policies & consent texts, Support: GD-08, BR-11..BR-13, D-25);
// they join when their operations exist. `stage` says when the screen arrives; until then the section opens a
// placeholder page (src/app/(console)/[section]/page.tsx), and a real page folder of the same name takes over.
import type { AdminOperationId, StaffRole } from '@/lib/api/generated';
import { canCallAny } from '@/lib/roles';
import type { IconName } from '@/components/ds/icon';
import { STAFF_ROLE_ORDER } from './roles';

export type SectionGroup = 'work' | 'records' | 'oversight' | 'settings';

export interface Section {
  id: SectionId;
  /** The URL path ('/' is the dashboard). */
  path: string;
  group: SectionGroup;
  icon: IconName;
  /** Visible when the caller may call one of these; empty = every staff member. */
  ops: readonly AdminOperationId[];
  /** The plan stage that builds the screen. */
  stage: string;
}

export type SectionId =
  | 'dashboard'
  | 'approvals'
  | 'verification'
  | 'reviews'
  | 'content'
  | 'inventory'
  | 'disputes'
  | 'privacy'
  | 'users'
  | 'orgs'
  | 'taxonomy'
  | 'ai'
  | 'mcp'
  | 'analytics'
  | 'audit'
  | 'plans'
  | 'flags'
  | 'rates'
  | 'retention'
  | 'staff';

export const SECTIONS: readonly Section[] = [
  { id: 'dashboard', path: '/', group: 'work', icon: 'home', ops: [], stage: 'AC5' },
  { id: 'approvals', path: '/approvals', group: 'work', icon: 'check', ops: ['admin.four_eyes_list'], stage: 'AC5' },
  { id: 'verification', path: '/verification', group: 'work', icon: 'shield', ops: ['admin.verifications_queue'], stage: 'AC9' },
  { id: 'reviews', path: '/reviews', group: 'work', icon: 'star', ops: ['admin.review_approvals_queue', 'admin.cases_list'], stage: 'AC7' },
  { id: 'content', path: '/content', group: 'work', icon: 'flag', ops: ['admin.reports_list', 'admin.cases_list'], stage: 'AC8' },
  { id: 'inventory', path: '/inventory', group: 'work', icon: 'part', ops: ['admin.cases_list'], stage: 'AC8' },
  { id: 'disputes', path: '/disputes', group: 'work', icon: 'comment', ops: ['admin.disputes_queue'], stage: 'AC7' },
  { id: 'privacy', path: '/privacy', group: 'work', icon: 'lock', ops: ['admin.dsr_queue'], stage: 'AC10' },
  { id: 'users', path: '/users', group: 'records', icon: 'user', ops: ['admin.users_search'], stage: 'AC10' },
  { id: 'orgs', path: '/orgs', group: 'records', icon: 'building', ops: ['admin.orgs_search'], stage: 'AC9' },
  {
    id: 'taxonomy',
    path: '/taxonomy',
    group: 'records',
    icon: 'tag',
    ops: ['admin.taxonomy_node_create', 'admin.synonyms_list', 'admin.mappings_list'],
    stage: 'AC12',
  },
  { id: 'ai', path: '/ai', group: 'oversight', icon: 'spark', ops: ['admin.ai_insights_search'], stage: 'AC13' },
  {
    id: 'mcp',
    path: '/mcp',
    group: 'oversight',
    icon: 'route',
    ops: ['admin.mcp_clients_list', 'admin.mcp_access_log_search'],
    stage: 'AC13',
  },
  { id: 'analytics', path: '/analytics', group: 'oversight', icon: 'gauge', ops: ['admin.analytics_dashboard'], stage: 'AC13' },
  { id: 'audit', path: '/audit', group: 'oversight', icon: 'list', ops: ['admin.audit_search'], stage: 'AC13' },
  { id: 'plans', path: '/plans', group: 'settings', icon: 'grid', ops: ['admin.plans_list'], stage: 'AC6' },
  { id: 'flags', path: '/flags', group: 'settings', icon: 'sliders', ops: ['admin.flags_list'], stage: 'AC6' },
  { id: 'rates', path: '/rates', group: 'settings', icon: 'refresh', ops: ['admin.exchange_rates_list'], stage: 'AC6' },
  { id: 'retention', path: '/retention', group: 'settings', icon: 'clock', ops: ['admin.retention_list'], stage: 'AC6' },
  {
    id: 'staff',
    path: '/staff',
    group: 'settings',
    icon: 'user',
    ops: ['admin.platform_role_grant', 'admin.platform_role_revoke'],
    stage: 'AC10',
  },
];

export const SECTION_GROUPS: readonly SectionGroup[] = ['work', 'records', 'oversight', 'settings'];

export function canOpen(section: Section, roles: readonly StaffRole[]): boolean {
  return section.ops.length === 0 ? roles.length > 0 : canCallAny(section.ops, roles);
}

export function visibleSections(roles: readonly StaffRole[]): Section[] {
  return SECTIONS.filter((s) => canOpen(s, roles));
}

/** The section a path belongs to (its first segment); undefined for unknown paths. */
export function sectionOfPath(path: string): Section | undefined {
  const pathname = path.split(/[?#]/)[0] ?? '/';
  if (pathname === '/' || pathname === '') return SECTIONS[0];
  const first = `/${pathname.split('/')[1] ?? ''}`;
  return SECTIONS.find((s) => s.path === first && s.path !== '/');
}

export function sectionBySlug(slug: string): Section | undefined {
  return SECTIONS.find((s) => s.path === `/${slug}` && s.path !== '/');
}

/** The staff roles that may open a section (for the no-permission page), in the contract's order. */
export function rolesFor(section: Section): StaffRole[] {
  return STAFF_ROLE_ORDER.filter((r) => canOpen(section, [r]));
}
