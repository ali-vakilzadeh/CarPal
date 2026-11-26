import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CounterTile, PreVisitReport, RequestCard, StateBlock, StatusChip, appointmentTone, showcaseTone, urgencyTone } from './index';

describe('@carpal/business-ui (PRV-GD-08)', () => {
  it('renders a status chip with the tone class', () => {
    render(<StatusChip label="New" tone={appointmentTone('requested')} />);
    expect(screen.getByText('New').className).toContain('cp-badge-signal');
  });

  it('gives the shared tones of appointment and showcase states', () => {
    expect(appointmentTone('completed')).toBe('success');
    expect(appointmentTone('cancelled')).toBe('danger');
    expect(appointmentTone('awaiting_parts')).toBe('accent');
    expect(appointmentTone('something_new')).toBe('neutral');
    expect(showcaseTone('live')).toBe('success');
    expect(showcaseTone('waiting_for_customer')).toBe('signal');
  });

  it('renders a counter tile as a link only when it has an address', () => {
    const { rerender } = render(<CounterTile label="New requests" value="3" alert="1 safety-critical" caption="Oldest waiting 11 h" />);
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('1 safety-critical')).toBeTruthy();
    rerender(<CounterTile label="New requests" value="3" href="/fa/provider/requests" />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/fa/provider/requests');
  });

  it('announces an error state and not an empty state', () => {
    const { rerender } = render(<StateBlock kind="error" title="Could not load" />);
    expect(screen.getByRole('status').textContent).toContain('Could not load');
    rerender(<StateBlock kind="empty" title="Nothing yet" />);
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('@carpal/business-ui PW3 components', () => {
  it('renders a request card with the safety mark and its link', () => {
    render(
      <RequestCard
        href="/en/provider/requests/a1"
        vehicle="BMW 320i (E90) 2012"
        subject="Front suspension noise"
        requester="Sara M."
        status={{ label: 'New', tone: 'signal' }}
        urgency={{
          label: 'Safety-critical',
          tone: urgencyTone('safety_critical'),
        }}
        safety="Safety-critical"
        when="Preferred: Thu 09:00–12:00"
        age="3 hours ago"
      />,
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/en/provider/requests/a1');
    expect(link.className).toContain('is-safety');
    expect(screen.getByRole('note').textContent).toBe('Safety-critical');
    expect(urgencyTone('high')).toBe('signal');
    expect(urgencyTone('low')).toBe('neutral');
  });

  const words = {
    issue: 'What the customer says',
    symptoms: 'Symptoms',
    aiLabel: 'AI pre-visit summary',
    aiNote: 'Not a diagnosis.',
    triageNone: 'Triage: not provided',
    triageNoneText: 'No Help Me.',
    likely: 'Likely services',
    expectations: 'Note',
    history: 'Service history',
    historyNotShared: 'Not shared by customer',
    warnings: 'Warnings',
    focus: 'Focus',
    media: 'Photos and video',
  };
  const data = {
    issue: 'Knock over bumps',
    symptoms: [],
    triage: false,
    aiSummary: null,
    likely: [],
    expectations: null,
    history: null,
    previous: [],
    warnings: [],
    focus: [],
  };

  it('says "Triage: not provided" and "Not shared by customer" without triage and consent', () => {
    render(<PreVisitReport words={words} data={data} />);
    expect(screen.getByText('Triage: not provided')).toBeTruthy();
    expect(screen.getByText('Not shared by customer')).toBeTruthy();
    expect(screen.queryByText('AI pre-visit summary')).toBeNull();
  });

  it('labels the AI summary and shows the shared history and media slot', () => {
    render(
      <PreVisitReport
        words={words}
        data={{
          ...data,
          triage: true,
          aiSummary: 'Likely bushings.',
          history: 'Brakes 14 months ago.',
          previous: ['2025-08 · Brakes'],
        }}
        media={<span>photo</span>}
      />,
    );
    expect(screen.getByText('AI pre-visit summary')).toBeTruthy();
    expect(screen.getByText('Likely bushings.')).toBeTruthy();
    expect(screen.getByText('Brakes 14 months ago.')).toBeTruthy();
    expect(screen.getByText('photo')).toBeTruthy();
    expect(screen.queryByText('Triage: not provided')).toBeNull();
  });
});
