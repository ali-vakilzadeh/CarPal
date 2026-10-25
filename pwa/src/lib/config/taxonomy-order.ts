// Picker order of taxonomy nodes, shared by the server cache and the browser hook: sort_order, then name.
import type { TaxonomyNode } from '@carpal/api-contracts';

export function sortNodes(nodes: readonly TaxonomyNode[]): TaxonomyNode[] {
  return [...nodes].sort((a, b) => a.sort_order - b.sort_order || a.name.text.localeCompare(b.name.text));
}
