// Q&A hub filters (W-QA-01; P8.T3), shared by the server page and the client hub: the URL carries ids only
// (?status&cat&brand&model, GD-14), never the search text.
export type QaStatus = 'open' | 'answered';
export interface QaFilters {
  status?: QaStatus;
  categoryId?: string;
  brandId?: string;
  modelId?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const QA_PAGE = 20;

/** URL → filters (unknown or malformed values dropped). */
export function parseQaFilters(params: URLSearchParams | Record<string, string | string[] | undefined>): QaFilters {
  const get = (k: string) => {
    const v = params instanceof URLSearchParams ? params.get(k) : params[k];
    return typeof v === 'string' ? v : undefined;
  };
  const id = (k: string) => {
    const v = get(k);
    return v && UUID.test(v) ? v : undefined;
  };
  const status = get('status');
  return {
    ...(status === 'open' || status === 'answered' ? { status } : {}),
    ...(id('cat') ? { categoryId: id('cat') } : {}),
    ...(id('brand') ? { brandId: id('brand') } : {}),
    ...(id('brand') && id('model') ? { modelId: id('model') } : {}),
  };
}

export function qaFilterQuery(f: QaFilters): string {
  const p = new URLSearchParams();
  if (f.status) p.set('status', f.status);
  if (f.categoryId) p.set('cat', f.categoryId);
  if (f.brandId) p.set('brand', f.brandId);
  if (f.brandId && f.modelId) p.set('model', f.modelId);
  return p.toString();
}

/** The questions.search body for filters, text and (optionally) the user's car. */
export function qaSearchBody(f: QaFilters, text: string, car: { brandId: string; modelId: string } | null) {
  const brand = car?.brandId ?? f.brandId;
  const model = car ? car.modelId : f.modelId;
  return {
    ...(text.trim() ? { text: text.trim().slice(0, 200) } : {}),
    ...(brand ? { brand_node_id: brand } : {}),
    ...(model ? { model_node_id: model } : {}),
    ...(f.categoryId ? { category_node_id: f.categoryId } : {}),
    ...(f.status ? { status: f.status } : {}),
    limit: QA_PAGE,
  };
}
