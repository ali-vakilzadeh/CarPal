// PW4: the Workshop job rules without React — job pages, steps, the status buttons from allowed_transitions, jobs on
// the floor today, money, the Awaiting parts body (cost range) and the Close job body (service record, cost split,
// part lines), server field errors and the prefill from the request.
import type { Appointment } from '@carpal/api-contracts';
import { describe, expect, it } from 'vitest';
import {
  awaitingParts,
  closeFieldOf,
  closeJob,
  floorJobs,
  hasJobPage,
  jobActions,
  jobLogDate,
  jobStep,
  parseMoney,
  partsUsed,
  prefillNode,
  sumMoney,
  type CloseDraft,
} from './job-model';

const NOW = Date.parse('2026-11-26T10:00:00Z');
const apt = (o: Partial<Appointment>): Appointment =>
  ({
    id: 'a',
    status: 'confirmed',
    allowed_transitions: [],
    confirmed_start_at: '2026-11-26T09:00:00Z',
    proposed_start_at: null,
    created_at: '2026-11-20T09:00:00Z',
    safety_flag: false,
    urgency_level: 'medium',
    ...o,
  }) as Appointment;

describe('jobs and steps', () => {
  it('gives a job page to booked visits and to the ones that ended after booking', () => {
    expect(hasJobPage(apt({ status: 'awaiting_parts' }))).toBe(true);
    expect(hasJobPage(apt({ status: 'completed' }))).toBe(true);
    expect(hasJobPage(apt({ status: 'cancelled' }))).toBe(true);
    expect(hasJobPage(apt({ status: 'cancelled', confirmed_start_at: null }))).toBe(false);
    expect(hasJobPage(apt({ status: 'provider_reviewing', confirmed_start_at: null }))).toBe(false);
  });

  it('puts Awaiting parts on the In progress step and leaves the steps when cancelled', () => {
    expect(jobStep('confirmed')).toBe(0);
    expect(jobStep('awaiting_parts')).toBe(jobStep('in_progress'));
    expect(jobStep('completed')).toBe(4);
    expect(jobStep('cancelled')).toBe(-1);
  });

  it('lists today’s visits and the jobs still in the workshop once, safety-critical first', () => {
    const today = [apt({ id: 't1' }), apt({ id: 'both', status: 'in_progress' })];
    const floor = [
      apt({ id: 'both', status: 'in_progress' }),
      apt({ id: 'old', status: 'awaiting_parts', urgency_level: 'safety_critical' }),
    ];
    expect(floorJobs(today, floor).map((a) => a.id)).toEqual(['old', 't1', 'both']);
  });
});

describe('status buttons (allowed_transitions)', () => {
  it('offers only what the server allows, the next step first', () => {
    const a = apt({ status: 'in_progress', allowed_transitions: ['awaiting_parts', 'ready_for_pickup', 'completed'] });
    expect(jobActions(a, NOW)).toEqual([
      { to: 'ready_for_pickup', kind: 'direct', primary: true },
      { to: 'completed', kind: 'close', primary: false },
      { to: 'awaiting_parts', kind: 'parts', primary: false },
    ]);
    expect(jobActions(apt({ status: 'awaiting_parts', allowed_transitions: ['in_progress', 'cancelled'] }), NOW)[0]).toEqual({
      to: 'in_progress',
      kind: 'direct',
      primary: true,
    });
  });

  it('offers no-show only from the booked start time on, and nothing once the job closed', () => {
    const allowed: Appointment['allowed_transitions'] = ['checked_in', 'no_show', 'cancelled'];
    const before = jobActions(apt({ confirmed_start_at: '2026-11-26T11:00:00Z', allowed_transitions: allowed }), NOW);
    expect(before.map((x) => x.to)).toEqual(['checked_in', 'cancelled']);
    const after = jobActions(apt({ allowed_transitions: allowed }), NOW);
    expect(after.map((x) => x.to)).toEqual(['checked_in', 'no_show', 'cancelled']);
    expect(jobActions(apt({ status: 'completed', allowed_transitions: ['completed'] }), NOW)).toEqual([]);
  });
});

describe('money', () => {
  it('reads Persian digits and separators and refuses what the contract refuses', () => {
    expect(parseMoney('۱٬۲۰۰٬۰۰۰')).toBe('1200000');
    expect(parseMoney('12٫5')).toBe('12.5');
    expect(parseMoney('0012.50')).toBe('12.50');
    expect(parseMoney('12.345')).toBeNull();
    expect(parseMoney('12345678901')).toBeNull();
    expect(parseMoney('-3')).toBeNull();
  });

  it('adds in cents, without float errors', () => {
    expect(sumMoney(['0.1', '0.2'])).toBe('0.3');
    expect(sumMoney(['12.05', '1'])).toBe('13.05');
    expect(sumMoney(['3000000', '1500000'])).toBe('4500000');
    expect(sumMoney(['9999999999', '1'])).toBeNull();
  });
});

describe('Awaiting parts', () => {
  const words = (from: string, to: string) => `Expected cost ${from}–${to}`;

  it('sends the note and the estimated completion, the range in words and its upper end as the estimate', () => {
    const r = awaitingParts(
      { note: 'Bushing torn.\nPart reserved.', completionAt: '2026-11-27T09:30:00Z', costFrom: '4000000', costTo: '۶۰۰۰۰۰۰' },
      words,
      NOW,
    );
    expect(r).toEqual({
      body: {
        to: 'awaiting_parts',
        parts_availability_note: 'Bushing torn. Part reserved. · Expected cost 4000000–6000000',
        estimated_completion_to: '2026-11-27T09:30:00Z',
      },
      estimate: '6000000',
    });
  });

  it('sends only what was given and checks the range', () => {
    expect(awaitingParts({ note: '', completionAt: null, costFrom: '', costTo: '' }, words, NOW)).toEqual({
      body: { to: 'awaiting_parts' },
      estimate: null,
    });
    expect(awaitingParts({ note: '', completionAt: null, costFrom: '5', costTo: '' }, words, NOW)).toMatchObject({ estimate: '5' });
    expect(awaitingParts({ note: '', completionAt: null, costFrom: '9', costTo: '5' }, words, NOW)).toEqual({ error: 'costOrder' });
    expect(awaitingParts({ note: '', completionAt: null, costFrom: 'x', costTo: '' }, words, NOW)).toEqual({ error: 'costFrom' });
    expect(awaitingParts({ note: '', completionAt: '2026-11-26T09:00:00Z', costFrom: '', costTo: '' }, words, NOW)).toEqual({
      error: 'past',
    });
  });

  it('keeps the note within 500 characters', () => {
    const r = awaitingParts({ note: 'x'.repeat(480), completionAt: null, costFrom: '1', costTo: '2' }, words, NOW);
    expect('body' in r && r.body.parts_availability_note!.length).toBe(500);
  });
});

describe('Close job', () => {
  const draft = (o: Partial<CloseDraft> = {}): CloseDraft => ({
    systemId: 'sys-susp',
    taskId: 'task-arm',
    labour: '1500000',
    parts: '3000000',
    lines: [{ name: 'Lemförder control arm', partNumber: '31 12 6 776 940', quantity: '1' }],
    warranty: '12 months on part and labour',
    ...o,
  });

  it('builds the service record with the cost split, the total and the part number (Docs/11 Ch.7)', () => {
    expect(closeJob(draft(), 'USD')).toEqual({
      body: {
        to: 'completed',
        final_cost: { amount: '4500000', currency: 'USD' },
        service_record: {
          service_system_node_id: 'sys-susp',
          service_task_node_id: 'task-arm',
          parts_used: [{ name: 'Lemförder control arm', part_number: '31 12 6 776 940', quantity: 1 }],
          cost_breakdown: { labor: '1500000', parts: '3000000' },
          warranty_note: '12 months on part and labour',
        },
      },
    });
  });

  it('needs the service category and sends only what was filled in', () => {
    expect(closeJob(draft({ systemId: '' }), 'USD')).toEqual({ errors: { system: true } });
    expect(closeJob(draft({ taskId: '', labour: '', parts: '', lines: [], warranty: '' }), 'USD')).toEqual({
      body: { to: 'completed', service_record: { service_system_node_id: 'sys-susp' } },
    });
    expect(closeJob(draft({ labour: '12.345', lines: [{ name: '', partNumber: 'X1', quantity: '1' }] }), 'USD')).toEqual({
      errors: { labour: true, lines: true },
    });
  });

  it('drops empty part rows and checks quantities', () => {
    expect(partsUsed([{ name: '', partNumber: '', quantity: '1' }])).toEqual([]);
    expect(partsUsed([{ name: 'Pad', partNumber: '', quantity: '۴' }])).toEqual([{ name: 'Pad', quantity: 4 }]);
    expect(partsUsed([{ name: 'Pad', partNumber: '', quantity: '0' }])).toBe('invalid');
  });

  it('puts server field errors beside their field', () => {
    expect(closeFieldOf('/service_record/service_task_node_id')).toBe('task');
    expect(closeFieldOf('/service_record/parts_used/0/name')).toBe('lines');
    expect(closeFieldOf('/final_cost/currency')).toBe('total');
    expect(closeFieldOf('/other')).toBeNull();
  });

  it('prefills from the report’s likely services, else from the request’s label', () => {
    const nodes = [
      { id: 'sys-brakes', name: { text: 'Brakes', locale: 'en' as const } },
      { id: 'sys-susp', name: { text: 'Suspension', locale: 'en' as const } },
    ];
    expect(prefillNode(nodes, 'Brakes', ['unknown', 'sys-susp'])).toBe('sys-susp');
    expect(prefillNode(nodes, ' suspension ')).toBe('sys-susp');
    expect(prefillNode(nodes, 'Engine')).toBe('');
    expect(prefillNode(nodes, null)).toBe('');
  });

  it('dates the job log like the service record (the completion’s UTC day)', () => {
    expect(jobLogDate('2026-11-26T22:30:00Z', NOW)).toBe('2026-11-26');
    expect(jobLogDate(null, NOW)).toBe('2026-11-26');
  });
});
