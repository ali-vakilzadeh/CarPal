import { describe, expect, it } from 'vitest';
import { rowToItem } from './import-row.js';
import {
  bestConfidence,
  catalogQualityScore,
  dataQualityScore,
  fulfillmentRate,
  inquiryTransitionAllowed,
  rateString,
  tradeDecision,
} from './rules.js';

describe('quality (54 §7.2)', () => {
  it('scores item data quality over six equal criteria', () => {
    const base = { images: 0, partNumbers: false, category: true, warrantyNote: false, description: false, stockStatus: true };
    expect(dataQualityScore(base)).toBe(33);
    expect(dataQualityScore({ ...base, images: 2, partNumbers: true })).toBe(67);
    expect(
      dataQualityScore({ images: 1, partNumbers: true, category: true, warrantyNote: true, description: true, stockStatus: true }),
    ).toBe(100);
  });

  it('weights fitment coverage 35, data completeness 35, fulfillment 30, re-weighting missing components', () => {
    expect(catalogQualityScore({ activeItems: 0, confirmedFitmentItems: 0, averageDataQuality: null, fulfillmentRate: null })).toBe(0);
    expect(catalogQualityScore({ activeItems: 4, confirmedFitmentItems: 2, averageDataQuality: 60, fulfillmentRate: null })).toBe(55);
    expect(catalogQualityScore({ activeItems: 4, confirmedFitmentItems: 2, averageDataQuality: 60, fulfillmentRate: 1 })).toBe(69);
    expect(catalogQualityScore({ activeItems: 0, confirmedFitmentItems: 0, averageDataQuality: null, fulfillmentRate: 0.5 })).toBe(50);
    expect(fulfillmentRate(0, 0)).toBeNull();
    expect(rateString(fulfillmentRate(7, 6))).toBe('0.8571');
  });
});

describe('inquiry transitions (40 §13.1)', () => {
  it('allows each side only its own moves', () => {
    expect(inquiryTransitionAllowed('vendor', 'sent', 'reserved')).toBe(true);
    expect(inquiryTransitionAllowed('vendor', 'sent', 'cancelled')).toBe(false);
    expect(inquiryTransitionAllowed('vendor', 'reserved', 'cancelled')).toBe(false);
    expect(inquiryTransitionAllowed('vendor', 'reserved', 'answered')).toBe(true);
    expect(inquiryTransitionAllowed('requester', 'sent', 'completed')).toBe(false);
    expect(inquiryTransitionAllowed('requester', 'answered', 'completed')).toBe(true);
    expect(inquiryTransitionAllowed('requester', 'completed', 'cancelled')).toBe(false);
  });

  it('decides trade accounts', () => {
    expect(tradeDecision('requested', 'approve')).toBe('approved');
    expect(tradeDecision('revoked', 'approve')).toBe('approved');
    expect(tradeDecision('approved', 'reject')).toBeNull();
    expect(tradeDecision('approved', 'revoke')).toBe('revoked');
    expect(tradeDecision('requested', 'revoke')).toBeNull();
  });
});

describe('fitment for a vehicle (54 §7.1)', () => {
  const row = (o: object) => ({
    brand_node_id: 'b',
    model_node_id: null,
    series_node_id: null,
    year_start: null,
    year_end: null,
    confidence: 'likely',
    ...o,
  });
  it('picks the best confidence among rows that agree with the vehicle', () => {
    const rows = [
      row({ confidence: 'uncertain' }),
      row({ model_node_id: 'm', year_start: 2010, year_end: 2015, confidence: 'confirmed' }),
      row({ model_node_id: 'x', confidence: 'confirmed' }),
    ];
    expect(bestConfidence(rows, { brand_node_id: 'b', model_node_id: 'm', year: 2012 })).toBe('confirmed');
    expect(bestConfidence(rows, { brand_node_id: 'b', model_node_id: 'm', year: 2018 })).toBe('uncertain');
    expect(bestConfidence(rows, { brand_node_id: 'b' })).toBe('uncertain');
    expect(bestConfidence(rows, { brand_node_id: 'other' })).toBeNull();
  });
});

describe('CSV rows (SEC-IN-11)', () => {
  const norm = (v: string) => ({ value: v.trim(), ok: !v.includes('‮') });
  const columns = [
    { index: 0, field: 'sku' as const },
    { index: 1, field: 'name_translations.en' as const },
    { index: 2, field: 'oem_numbers' as const },
    { index: 3, field: 'price_on_request' as const },
    { index: 4, field: 'stock_quantity' as const },
    { index: 5, field: 'currency' as const },
    { index: 6, field: 'condition' as const },
  ];
  it('maps cells to fields with strict parsing; formula-like text stays data', () => {
    expect(rowToItem(['A-1', '=HYPERLINK("x")', '123|456; 789', 'yes', '12', 'irr', 'NEW'], columns, 7, norm)).toEqual({
      item: {
        sku: 'A-1',
        name_translations: { en: '=HYPERLINK("x")' },
        oem_numbers: ['123', '456', '789'],
        price_on_request: true,
        stock_quantity: 12,
        currency: 'IRR',
        condition: 'new',
      },
      problems: [],
    });
  });

  it('reports unparsable cells, rejected characters and short rows', () => {
    expect(rowToItem(['A-2', 'Pad‮', '', 'maybe', '1.5', '', ''], columns, 7, norm).problems).toEqual([
      { pointer: '/name_translations/en', code: 'forbidden_character' },
      { pointer: '/price_on_request', code: 'type' },
      { pointer: '/stock_quantity', code: 'type' },
    ]);
    expect(rowToItem(['A-3'], columns, 7, norm).problems).toEqual([{ pointer: '/', code: 'pattern' }]);
  });
});
