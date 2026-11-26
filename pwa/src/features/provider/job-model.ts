// CarPal Workshop jobs (provider plan PW4: PW-JOB-01) without React: which booked visits are jobs, where a job stands
// in its steps, the status buttons the server allows (Appointment.allowed_transitions, PRV-GD-03; Docs/40 §16
// transitions by side), the Awaiting parts body (note, estimated completion, cost range), and the Close job body
// (Docs/40 AppointmentTransition 'completed': final_cost, service_record with system, task, parts_used, cost_breakdown,
// warranty_note). Money is a decimal string in the region's base currency (backend GD-41); sums are in cents.
import type { Appointment, AppointmentStatus, AppointmentTransition, PartUsed, TaxonomyNode } from '@carpal/api-contracts';
import { toLatinDigits } from '@/lib/format';
import { safetyFirst } from './model';

// ---------------------------------------------------------------- jobs and steps

/** Booked visits from confirmation until they close (backend PROVIDER_GROUPS upcoming + in_progress). */
export const JOB_STATUSES: readonly AppointmentStatus[] = ['confirmed', 'checked_in', 'in_progress', 'awaiting_parts', 'ready_for_pickup'];
export const isOpenJob = (a: Pick<Appointment, 'status'>) => JOB_STATUSES.includes(a.status);

/** A visit that has a job page: open jobs and the ones that ended after booking (completed, no-show, cancelled once booked). */
export const hasJobPage = (a: Pick<Appointment, 'status' | 'confirmed_start_at'>) =>
  isOpenJob(a) || a.status === 'completed' || a.status === 'no_show' || (a.status === 'cancelled' && !!a.confirmed_start_at);

/** The steps of PW-JOB-01: Booked, Car arrived, In progress, Ready for pickup, Completed. */
export const JOB_STEPS = ['confirmed', 'checked_in', 'in_progress', 'ready_for_pickup', 'completed'] as const;
export type JobStepKey = (typeof JOB_STEPS)[number];

/** Index of the current step; Awaiting parts sits on In progress; -1 once the job left the steps. */
export function jobStep(status: AppointmentStatus): number {
  if (status === 'awaiting_parts') return JOB_STEPS.indexOf('in_progress');
  return (JOB_STEPS as readonly string[]).indexOf(status);
}

/**
 * Jobs on the floor today: today's booked visits (group=today, keyed on the visit's start day) and the jobs still in
 * the workshop from earlier days (group=in_progress: checked in, in progress, awaiting parts, ready for pickup), one
 * entry per appointment, safety-critical first.
 */
export function floorJobs<A extends Appointment>(today: readonly A[], inWorkshop: readonly A[]): A[] {
  const byId = new Map<string, A>();
  for (const a of [...today, ...inWorkshop]) if (!byId.has(a.id)) byId.set(a.id, a);
  return safetyFirst([...byId.values()]);
}

// ---------------------------------------------------------------- status buttons

/**
 * How a status button works: 'direct' sends the transition on a tap; 'parts' opens the Awaiting parts sheet; 'close'
 * opens Close job; 'confirm' asks first (no-show); 'cancel' asks for a reason.
 */
export type JobActionKind = 'direct' | 'parts' | 'close' | 'confirm' | 'cancel';

export interface JobActionSpec {
  to: AppointmentStatus;
  kind: JobActionKind;
  primary: boolean;
}

const ACTION_ORDER: readonly { to: AppointmentStatus; kind: JobActionKind }[] = [
  { to: 'checked_in', kind: 'direct' },
  { to: 'in_progress', kind: 'direct' },
  { to: 'ready_for_pickup', kind: 'direct' },
  { to: 'completed', kind: 'close' },
  { to: 'awaiting_parts', kind: 'parts' },
  { to: 'no_show', kind: 'confirm' },
  { to: 'cancelled', kind: 'cancel' },
];

/** The next step forward of a status (the primary button). */
const NEXT: Partial<Record<AppointmentStatus, AppointmentStatus>> = {
  confirmed: 'checked_in',
  checked_in: 'in_progress',
  in_progress: 'ready_for_pickup',
  awaiting_parts: 'in_progress',
  ready_for_pickup: 'completed',
};

/**
 * PW-JOB-01 status buttons from allowed_transitions only. No-show only from the booked start time on (the backend
 * refuses it earlier with INVALID_TRANSITION, which is not "changed meanwhile").
 */
export function jobActions(a: Pick<Appointment, 'status' | 'allowed_transitions' | 'confirmed_start_at'>, now: number): JobActionSpec[] {
  if (!isOpenJob(a)) return [];
  const next = NEXT[a.status];
  return ACTION_ORDER.filter(({ to }) => a.allowed_transitions.includes(to))
    .filter(({ to }) => to !== 'no_show' || (!!a.confirmed_start_at && Date.parse(a.confirmed_start_at) <= now))
    .map(({ to, kind }) => ({ to, kind, primary: to === next }))
    .sort((x, y) => Number(y.primary) - Number(x.primary));
}

// ---------------------------------------------------------------- money

const MONEY = /^\d{1,10}(\.\d{1,2})?$/;

/** A typed amount as the contract's decimal string ("1250000", "12.5"), Persian digits and separators allowed; null if invalid. */
export function parseMoney(raw: string): string | null {
  const s = toLatinDigits(raw.trim())
    .replace(/[\s,٬']/g, '')
    .replace('٫', '.');
  if (!MONEY.test(s)) return null;
  return s.replace(/^0+(?=\d)/, '');
}

const cents = (amount: string) => {
  const [whole, frac = ''] = amount.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
};

/** The sum of decimal strings, as a decimal string; null when it no longer fits the contract (10 digits). */
export function sumMoney(amounts: readonly string[]): string | null {
  const total = amounts.reduce((n, a) => n + cents(a), 0);
  const whole = Math.floor(total / 100);
  const frac = total % 100;
  const out = frac ? `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}` : String(whole);
  return MONEY.test(out) ? out : null;
}

export const moneyGreater = (a: string, b: string) => cents(a) > cents(b);

// ---------------------------------------------------------------- Awaiting parts

export const MAX_PARTS_NOTE = 500;

export interface PartsDraft {
  note: string;
  /** Estimated completion at the shop, as an instant (ISO), or null. */
  completionAt: string | null;
  costFrom: string;
  costTo: string;
}

export type PartsError = 'costFrom' | 'costTo' | 'costOrder' | 'past';

/**
 * The Awaiting parts request (Docs/11 Ch.6: note, estimated completion, expected cost range). The transition carries
 * the note and the estimated completion; the contract has no cost range, so the range goes into the note's words and
 * its upper end into the appointment's cost_estimate (provider.appointments_update, which W-APP-01 shows).
 */
export function awaitingParts(
  d: PartsDraft,
  rangeWords: (from: string, to: string) => string,
  now = Date.now(),
): { body: Extract<AppointmentTransition, { to: 'awaiting_parts' }>; estimate: string | null } | { error: PartsError } {
  const from = d.costFrom.trim() ? parseMoney(d.costFrom) : null;
  const to = d.costTo.trim() ? parseMoney(d.costTo) : null;
  if (d.costFrom.trim() && from === null) return { error: 'costFrom' };
  if (d.costTo.trim() && to === null) return { error: 'costTo' };
  if (from && to && moneyGreater(from, to)) return { error: 'costOrder' };
  if (d.completionAt && Date.parse(d.completionAt) <= now) return { error: 'past' };
  const range = from && to && from !== to ? rangeWords(from, to) : '';
  const words = d.note.trim().replace(/[\r\n]+/g, ' ');
  const note = [...[words, range].filter(Boolean).join(' · ')].slice(0, MAX_PARTS_NOTE).join('');
  return {
    body: {
      to: 'awaiting_parts',
      ...(note ? { parts_availability_note: note } : {}),
      ...(d.completionAt ? { estimated_completion_to: d.completionAt } : {}),
    },
    estimate: to ?? from,
  };
}

// ---------------------------------------------------------------- Close job

export interface PartRow {
  name: string;
  partNumber: string;
  quantity: string;
}

export interface CloseDraft {
  systemId: string;
  taskId: string;
  labour: string;
  parts: string;
  lines: readonly PartRow[];
  warranty: string;
}

export type CloseField = 'system' | 'task' | 'labour' | 'parts' | 'lines' | 'warranty' | 'total';
export type CloseErrors = Partial<Record<CloseField, true>>;

/** The part lines a form row gives (empty rows dropped), or 'invalid' for a row without a name or with a bad quantity. */
export function partsUsed(rows: readonly PartRow[]): PartUsed[] | 'invalid' {
  const out: PartUsed[] = [];
  for (const r of rows) {
    const name = r.name.trim();
    const number = r.partNumber.trim();
    if (!name && !number) continue;
    const qty = Number(toLatinDigits(r.quantity.trim() || '1'));
    if (!name || !Number.isInteger(qty) || qty < 1 || qty > 10_000) return 'invalid';
    out.push({ name: name.slice(0, 160), quantity: qty, ...(number ? { part_number: number.slice(0, 100) } : {}) });
  }
  return out;
}

/**
 * The Close job transition (Docs/11 Ch.7): the service record (system required: without it the server creates no
 * record), the cost split as cost_breakdown {labor, parts} and its sum as final_cost in the base currency.
 */
export function closeJob(
  d: CloseDraft,
  currency: string,
): { body: Extract<AppointmentTransition, { to: 'completed' }> } | { errors: CloseErrors } {
  const e: CloseErrors = {};
  if (!d.systemId) e.system = true;
  const labour = d.labour.trim() ? parseMoney(d.labour) : null;
  const parts = d.parts.trim() ? parseMoney(d.parts) : null;
  if (d.labour.trim() && labour === null) e.labour = true;
  if (d.parts.trim() && parts === null) e.parts = true;
  const lines = partsUsed(d.lines);
  if (lines === 'invalid') e.lines = true;
  const total = labour || parts ? sumMoney([labour, parts].filter((x): x is string => !!x)) : null;
  if ((labour || parts) && total === null) e.total = true;
  const warranty = d.warranty.trim().replace(/[\r\n]+/g, ' ');
  if (warranty.length > 500) e.warranty = true;
  if (Object.keys(e).length || lines === 'invalid') return { errors: e };
  return {
    body: {
      to: 'completed',
      ...(total ? { final_cost: { amount: total, currency } } : {}),
      service_record: {
        service_system_node_id: d.systemId,
        ...(d.taskId ? { service_task_node_id: d.taskId } : {}),
        ...(lines.length ? { parts_used: lines } : {}),
        ...(labour || parts ? { cost_breakdown: { ...(labour ? { labor: labour } : {}), ...(parts ? { parts } : {}) } } : {}),
        ...(warranty ? { warranty_note: warranty } : {}),
      },
    },
  };
}

/** Server field errors of a Close job (422 pointers) → the form field to show them beside. */
export function closeFieldOf(pointer: string): CloseField | null {
  if (pointer.startsWith('/service_record/service_system_node_id')) return 'system';
  if (pointer.startsWith('/service_record/service_task_node_id')) return 'task';
  if (pointer.startsWith('/service_record/parts_used')) return 'lines';
  if (pointer.startsWith('/service_record/warranty_note')) return 'warranty';
  if (pointer.startsWith('/service_record/cost_breakdown/labor')) return 'labour';
  if (pointer.startsWith('/service_record/cost_breakdown/parts')) return 'parts';
  if (pointer.startsWith('/final_cost')) return 'total';
  return null;
}

// ---------------------------------------------------------------- prefill from the request

const norm = (s: string) => s.trim().toLocaleLowerCase();

/**
 * The node to prefill from the request: one of the pre-visit report's likely services that is in the list, else the
 * node whose name is the request's label (the Appointment carries labels, not node ids). Empty when nothing matches.
 */
export function prefillNode(
  nodes: readonly Pick<TaxonomyNode, 'id' | 'name'>[],
  label: string | null | undefined,
  likelyIds: readonly string[] = [],
): string {
  const ids = new Set(nodes.map((n) => n.id));
  const likely = likelyIds.find((id) => ids.has(id));
  if (likely) return likely;
  if (!label) return '';
  const want = norm(label);
  return nodes.find((n) => norm(n.name.text) === want)?.id ?? '';
}

/** The day of a job log for a completed visit: the completion's UTC day, as the service record has it (backend). */
export const jobLogDate = (completedAt: string | null, now: number) => new Date(completedAt ?? now).toISOString().slice(0, 10);
