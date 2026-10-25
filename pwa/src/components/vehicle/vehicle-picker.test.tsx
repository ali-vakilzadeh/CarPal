// P3.T7: brand → model → series picker over the taxonomy cache (keyed by the taxonomy version).
import type { TaxonomyNode, TaxonomyType } from '@carpal/api-contracts';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../../tests/support/render-app';
import { EMPTY_PICK, VehiclePicker, type VehiclePick } from './vehicle-picker';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));

const node = (id: string, type: TaxonomyType, name: string, parent: string | null = null, sort = 0): TaxonomyNode => ({
  id,
  type,
  parent_id: parent,
  name: { text: name, locale: 'en' },
  description: null,
  slug: id,
  regions: [],
  attributes: null,
  sort_order: sort,
  status: 'active',
  merged_into_id: null,
});

const NODES: TaxonomyNode[] = [
  node('bmw', 'vehicle_brand', 'BMW', null, 2),
  node('toyota', 'vehicle_brand', 'Toyota', null, 1),
  node('s3', 'vehicle_model', '3 Series', 'bmw'),
  node('x5', 'vehicle_model', 'X5', 'bmw'),
  node('corolla', 'vehicle_model', 'Corolla', 'toyota'),
  node('e90', 'vehicle_series', 'E90', 's3'),
];

function Harness({ onChange }: { onChange: (v: VehiclePick) => void }) {
  const [value, setValue] = useState<VehiclePick>(EMPTY_PICK);
  return (
    <VehiclePicker
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

describe('VehiclePicker', () => {
  it('loads brands, then the models of the brand, then the series; changing the brand clears the rest', async () => {
    const snapshot = vi.fn(({ query }: Record<string, unknown>) => {
      const q = query as { type: TaxonomyType; parent_id?: string };
      return { items: NODES.filter((n) => n.type === q.type && (q.parent_id ? n.parent_id === q.parent_id : true)), next_cursor: null };
    });
    const onChange = vi.fn();
    renderApp(<Harness onChange={onChange} />, { locale: 'en', handlers: { 'taxonomy.snapshot': snapshot } });

    const brand = screen.getByLabelText('Brand');
    const model = screen.getByLabelText('Model');
    expect(model).toBeDisabled();
    expect(model).toHaveAccessibleDescription('Choose a brand first');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Toyota' })).toBeInTheDocument());
    expect([...(brand as HTMLSelectElement).options].map((o) => o.textContent)).toEqual(['Choose a brand', 'Toyota', 'BMW']);

    fireEvent.change(brand, { target: { value: 'bmw' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'X5' })).toBeInTheDocument());
    expect(snapshot).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.objectContaining({ type: 'vehicle_model', parent_id: 'bmw' }) }),
    );
    fireEvent.change(model, { target: { value: 's3' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'E90' })).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('Series (optional)'), { target: { value: 'e90' } });
    expect(onChange).toHaveBeenLastCalledWith({ brandId: 'bmw', modelId: 's3', seriesId: 'e90' });

    fireEvent.change(brand, { target: { value: 'toyota' } });
    expect(onChange).toHaveBeenLastCalledWith({ brandId: 'toyota', modelId: null, seriesId: null });
  });

  it('pages through the snapshot and shows a retryable error', async () => {
    let fail = true;
    const snapshot = vi.fn(({ query }: Record<string, unknown>) => {
      if (fail) throw new Error('down');
      const q = query as { cursor?: string };
      return q.cursor
        ? { items: [node('kia', 'vehicle_brand', 'Kia')], next_cursor: null }
        : { items: [node('bmw', 'vehicle_brand', 'BMW')], next_cursor: 'p2' };
    });
    renderApp(<Harness onChange={vi.fn()} />, { locale: 'en', handlers: { 'taxonomy.snapshot': snapshot } });
    expect(await screen.findByText('The list could not be loaded.')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Kia' })).toBeInTheDocument());
    expect(screen.getByRole('option', { name: 'BMW' })).toBeInTheDocument();
  });
});
