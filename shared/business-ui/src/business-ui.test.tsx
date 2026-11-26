import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  CounterTile,
  JobStatusBar,
  PartLines,
  PreVisitReport,
  RequestCard,
  StateBlock,
  StatusChip,
  appointmentTone,
  showcaseTone,
  urgencyTone,
  type PartLine,
} from './index';

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

describe('@carpal/business-ui PW4 components', () => {
  it('renders the job steps with the current one, its mark and the actions', () => {
    const onClick = vi.fn();
    render(
      <JobStatusBar
        label="Job progress"
        steps={[
          { key: 'confirmed', label: 'Booked' },
          { key: 'in_progress', label: 'In progress' },
          { key: 'completed', label: 'Completed' },
        ]}
        current={1}
        mark="Awaiting parts"
        actionsLabel="Update job"
        actions={[
          { key: 'in_progress', label: 'Start work', variant: 'primary', onClick },
          { key: 'cancelled', label: 'Cancel visit', variant: 'ghost', onClick: vi.fn(), disabled: true },
        ]}
      />,
    );
    const current = screen.getByText('In progress').closest('li')!;
    expect(current.getAttribute('aria-current')).toBe('step');
    expect(current.textContent).toContain('Awaiting parts');
    expect(screen.getByText('Booked').closest('li')!.className).toContain('is-done');
    fireEvent.click(screen.getByRole('button', { name: 'Start work' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Cancel visit' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('group', { name: 'Update job' })).toBeTruthy();
  });

  it('edits part lines: add, type, remove', () => {
    let rows: PartLine[] = [];
    const words = {
      legend: 'Parts used',
      name: 'Part',
      partNumber: 'Part number',
      quantity: 'Qty',
      add: 'Add a part',
      remove: (n: number) => `Remove part ${n}`,
    };
    const onChange = (next: PartLine[]) => {
      rows = next;
      rerender(<PartLines rows={rows} onChange={onChange} words={words} />);
    };
    const { rerender } = render(<PartLines rows={rows} onChange={onChange} words={words} error={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add a part' }));
    expect(rows).toEqual([{ name: '', partNumber: '', quantity: '1' }]);
    fireEvent.change(screen.getByLabelText('Part number'), { target: { value: '31126776940' } });
    expect(rows[0]!.partNumber).toBe('31126776940');
    expect(screen.getByLabelText('Part number').getAttribute('dir')).toBe('ltr');
    fireEvent.click(screen.getByRole('button', { name: 'Remove part 1' }));
    expect(rows).toEqual([]);
    rerender(
      <PartLines rows={[{ name: '', partNumber: 'X', quantity: '1' }]} onChange={onChange} words={words} error="Each part needs a name" />,
    );
    expect(screen.getByRole('alert').textContent).toBe('Each part needs a name');
  });
});
