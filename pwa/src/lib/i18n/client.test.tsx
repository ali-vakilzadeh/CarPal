// P3.T2: the client provider renders the namespaces the server passed, nested providers add theirs, and the boot
// script of P3.T3 picks the automatic theme before paint.
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { THEME_BOOT_SCRIPT } from '@/lib/theme';
import { I18nNamespaces, I18nProvider, useDirection, useLocale, useT } from './client';
import { BUNDLED, pickNamespaces } from './dictionary';

function Probe() {
  const t = useT();
  return (
    <p data-dir={useDirection()} data-locale={useLocale()}>
      {t('shell.nav.garage')} | {t('vehicle.picker.brand')} | {t('shell.garageBox.openIssues', { count: 2 })}
    </p>
  );
}

describe('I18nProvider', () => {
  it('translates with the namespaces it was given; nested providers add more', () => {
    render(
      <I18nProvider locale="fa" resources={pickNamespaces(BUNDLED.fa, ['shell'])}>
        <Probe />
      </I18nProvider>,
    );
    const p = screen.getByText(/گاراژ من/);
    expect(p).toHaveTextContent('گاراژ من | vehicle.picker.brand | ۲ مشکل باز');
    expect(p).toHaveAttribute('data-dir', 'rtl');
    expect(p).toHaveAttribute('data-locale', 'fa');
  });

  it('nested namespaces', () => {
    render(
      <I18nProvider locale="en" resources={pickNamespaces(BUNDLED.en, ['shell'])}>
        <I18nNamespaces resources={pickNamespaces(BUNDLED.en, ['vehicle'])}>
          <Probe />
        </I18nNamespaces>
      </I18nProvider>,
    );
    expect(screen.getByText(/My Garage/)).toHaveTextContent('My Garage | Brand | 2 open issues');
  });
});

describe('theme boot script', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-choice');
    vi.unstubAllGlobals();
  });

  const run = (matches: (q: string) => boolean) => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: matches(q) }));
    new Function(THEME_BOOT_SCRIPT)();
  };

  it('sets the automatic theme only when the server rendered "auto"', () => {
    const html = document.documentElement;
    html.setAttribute('data-theme', 'light');
    html.setAttribute('data-theme-choice', 'auto');
    run((q) => q.includes('dark'));
    expect(html).toHaveAttribute('data-theme', 'dark');
    run((q) => q.includes('contrast'));
    expect(html).toHaveAttribute('data-theme', 'sun');

    html.setAttribute('data-theme', 'light');
    html.setAttribute('data-theme-choice', 'light');
    run(() => true);
    expect(html).toHaveAttribute('data-theme', 'light');
  });
});
