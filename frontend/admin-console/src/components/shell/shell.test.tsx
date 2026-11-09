import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { getTranslator } from '@/lib/i18n/dictionary';
import { EnvBadge } from './env-badge';
import { SystemPage } from './system-page';

describe('environment badge (GD-06)', () => {
  it('names the environment, with a hint for screen readers', () => {
    render(<EnvBadge env="prod" t={getTranslator('en')} />);
    const badge = screen.getByTestId('env-badge');
    expect(badge).toHaveAttribute('data-env', 'prod');
    expect(badge).toHaveTextContent('Environment: PROD — Production: changes affect real users.');
  });

  it('is translated', () => {
    render(<EnvBadge env="staging" t={getTranslator('fa')} />);
    expect(screen.getByTestId('env-badge')).toHaveTextContent('آزمایشی');
  });
});

describe('system pages (AC1.T5)', () => {
  it.each(['notFound', 'forbidden', 'error'] as const)('%s has a heading and a way home', (kind) => {
    render(<SystemPage kind={kind} t={getTranslator('en')} />);
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to the console home' })).toHaveAttribute('href', '/');
  });

  it('shows the error reference, never the message', () => {
    render(<SystemPage kind="error" t={getTranslator('en')} digest="12345" />);
    expect(screen.getByText('Reference: 12345')).toBeInTheDocument();
  });
});
