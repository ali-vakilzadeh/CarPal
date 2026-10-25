import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NotFoundContent } from './not-found-content';
import { LanguageLink, ThemeLinks } from './preference-links';

describe('preference links', () => {
  it('links to the same page in the other language', () => {
    render(<LanguageLink locale="fa" path="/garage" />);
    const link = screen.getByRole('link', { name: 'English' });
    expect(link).toHaveAttribute('href', '/en/garage');
    expect(link).toHaveAttribute('hreflang', 'en');
  });

  it('marks the current theme with a check and aria-current', () => {
    render(<ThemeLinks locale="en" current="sun" />);
    const nav = screen.getByRole('navigation', { name: 'Theme' });
    expect(nav).toBeInTheDocument();
    const sun = screen.getByRole('link', { name: 'Sunlight' });
    expect(sun).toHaveAttribute('aria-current', 'true');
    expect(sun).toHaveClass('cp-chip', 'is-selected');
    expect(sun.querySelector('svg')).not.toBeNull();
    expect(screen.getByRole('link', { name: 'Night' })).toHaveAttribute('href', '/en?theme=dark');
  });
});

describe('NotFoundContent', () => {
  it('renders the localized 404 with a way home', () => {
    render(<NotFoundContent locale="fa" />);
    expect(screen.getByRole('heading', { level: 1, name: 'صفحه پیدا نشد' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'رفتن به صفحه اصلی' })).toHaveAttribute('href', '/fa');
  });
});
