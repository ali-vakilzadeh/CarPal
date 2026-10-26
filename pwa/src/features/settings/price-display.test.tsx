// OQ-11: the per-browser price display — rate input, unit and "Convert USD prices with this rate".
import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '../../../tests/support/render-app';
import { router } from '../../../tests/support/next-navigation';
import { parsePriceDisplay } from '@/lib/format';
import { parseRate, PriceDisplaySettings } from './price-display';

vi.mock('next/navigation', () => import('../../../tests/support/next-navigation'));

beforeEach(() => {
  document.cookie = 'cp_price=; Max-Age=0; Path=/';
  router.refresh.mockClear();
});

const cookie = () => /(?:^|; )cp_price=([^;]*)/.exec(document.cookie)?.[1];

describe('price display settings', () => {
  it('reads rates typed with Persian digits and separators', () => {
    expect(parseRate('105,000')).toBe(105000);
    expect(parseRate('۱۰۵٬۰۰۰')).toBe(105000);
    expect(parseRate('105000.5')).toBe(105000.5);
    expect(parseRate('0')).toBeNull();
    expect(parseRate('abc')).toBeNull();
  });

  it('previews, saves to the cookie and re-renders the page', () => {
    renderApp(<PriceDisplaySettings />, { locale: 'en' });
    expect(screen.getByText('Example: 10 US dollars → $10')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('1 US dollar in Toman'), { target: { value: '105,000' } });
    fireEvent.click(screen.getByLabelText('Convert USD prices with this rate'));
    expect(screen.getByText('Example: 10 US dollars → 1,050,000 T')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(parsePriceDisplay(cookie())).toEqual({ convertUsd: true, usdRate: 105000, unit: 'toman' });
    expect(router.refresh).toHaveBeenCalledOnce();
    expect(screen.getByText('Price display saved')).toBeInTheDocument();
  });

  it('needs a rate to convert', () => {
    renderApp(<PriceDisplaySettings />, { locale: 'en' });
    fireEvent.click(screen.getByRole('button', { name: 'Rial' }));
    fireEvent.click(screen.getByLabelText('Convert USD prices with this rate'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Enter a rate above 0.')).toBeInTheDocument();
    expect(cookie()).toBeUndefined();
  });
});
