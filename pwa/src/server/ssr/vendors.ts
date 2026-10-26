// Data of the parts-seller page (P5.T4): the seller's part categories (public.org_get vendor coverage) and the first
// page of parts in the first category, server-rendered so crawlers reach the part pages (a search without text,
// category or vehicle is refused, SEC-BF-4; beyond page 1 only with a search term, Docs/22 W-PUB-03).
import 'server-only';
import type { PublicInventoryCard, PublicOrgProfile } from '@carpal/api-contracts';
import type { Locale } from '@/lib/i18n/locales';
import { publicList } from './public-reads';

export const PARTS_PAGE = 12;

export function partCategories(p: PublicOrgProfile): { id: string; label: string }[] {
  return (p.vendor?.coverage ?? []).filter((c) => c.coverage_type === 'part_category').map((c) => ({ id: c.node_id, label: c.label.text }));
}

export async function firstParts(
  locale: Locale,
  p: PublicOrgProfile,
): Promise<{ category: string | null; page: { items: PublicInventoryCard[]; next_cursor: string | null } | null }> {
  const category = partCategories(p)[0]?.id ?? null;
  if (!category) return { category: null, page: null };
  const page = await publicList(locale, 'public.org_inventory_search', {
    path: { org_id: p.id },
    body: { part_category_node_id: category, limit: PARTS_PAGE },
  });
  return { category, page };
}
