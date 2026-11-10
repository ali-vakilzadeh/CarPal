'use client';
// CaseLayout, EntityChip, Timeline, AiEvidenceBlock and SlaBadge (AC5.T5, Docs/23 §1 principles 3 and 6, §3.2, §3.3).
// CaseLayout is the three-panel work screen: the queue list (320 px), the item with its context (flexible) and the
// decision panel (360 px); below 1280 px the decision panel moves under the item, below 900 px everything stacks in
// the order list, item, decision. Each panel is a labelled region, so screen-reader users can jump between them.
import Link from 'next/link';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Badge } from '@/components/ds/badge';
import { Icon, type IconName } from '@/components/ds/icon';
import { canCall } from '@/lib/roles';
import type { SlaState } from '@/lib/config/sla';
import { Bidi } from '@/lib/format/bidi';
import { useFormat } from '@/lib/format/client';
import { useSession } from '@/lib/api/query';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';

export interface CaseLayoutProps {
  list: ReactNode;
  item: ReactNode;
  decision?: ReactNode;
  /** Region names (defaults: "Queue", "Item", "Decision"). */
  labels?: { list?: string; item?: string; decision?: string };
}

export function CaseLayout({ list, item, decision, labels }: CaseLayoutProps) {
  const t = useT();
  return (
    <div className="adm-case" data-kit="case-layout" data-has-decision={decision ? 'true' : 'false'}>
      <section className="adm-case-list" aria-label={labels?.list ?? t('admin.kit.case.list')}>
        {list}
      </section>
      <section className="adm-case-item" aria-label={labels?.item ?? t('admin.kit.case.item')}>
        {item}
      </section>
      {decision ? (
        <section className="adm-case-decision" aria-label={labels?.decision ?? t('admin.kit.case.decision')}>
          {decision}
        </section>
      ) : null}
    </div>
  );
}

export type EntityType =
  | 'user'
  | 'organization'
  | 'review'
  | 'appointment'
  | 'case'
  | 'dispute'
  | 'report'
  | 'change'
  | 'media'
  | 'service_record'
  | 'badge'
  | 'moderation_action'
  // Moderation targets (AC8, Docs/40 ReportTargetType).
  | 'post'
  | 'comment'
  | 'question'
  | 'answer'
  | 'portfolio_item'
  | 'media_asset'
  | 'review_response'
  | 'inventory_item'
  | 'inventory_fitment'
  | 'organization_location'
  | 'ai_output';

const ENTITY_ICON: Record<EntityType, IconName> = {
  user: 'user',
  organization: 'building',
  review: 'star',
  appointment: 'calendar',
  case: 'flag',
  dispute: 'comment',
  report: 'alert',
  change: 'check',
  media: 'image',
  service_record: 'wrench',
  badge: 'shield',
  moderation_action: 'flag',
  post: 'doc',
  comment: 'comment',
  question: 'help',
  answer: 'chat',
  portfolio_item: 'camera',
  media_asset: 'image',
  review_response: 'comment',
  inventory_item: 'part',
  inventory_fitment: 'car',
  organization_location: 'pin',
  ai_output: 'spark',
};

export interface EntityChipProps {
  type: EntityType | (string & {});
  id: string;
  /** Display name; without one the chip shows the short id. */
  label?: string;
  /** The entity's page (with the work item's purpose, withPurpose); none = no "Open" link. */
  href?: string;
  /** Preview content of the popover (a few facts the page already has). */
  preview?: ReactNode;
}

/** A clickable chip for a linked record: a small popover with a preview and a link to its page. */
export function EntityChip({ type, id, label, href, preview }: EntityChipProps) {
  const t = useT();
  const f = useFormat();
  const uid = useId();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const known = type in ENTITY_ICON;
  const typeName = known ? t(`admin.kit.entity.${type}` as MessageKey) : t('admin.kit.unknown', { value: type });
  const shortId = id.length > 12 ? `…${id.slice(-8)}` : id;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <span className="adm-entity" data-kit="entity-chip" data-entity={type}>
      <button
        ref={button}
        type="button"
        className="cp-chip adm-entity-chip"
        aria-expanded={open}
        aria-controls={`${uid}-p`}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={known ? ENTITY_ICON[type as EntityType] : 'info'} size={16} />
        <span className="sr-only">{typeName}: </span>
        <Bidi>{label ?? f.digits(shortId)}</Bidi>
      </button>
      <div
        ref={panel}
        id={`${uid}-p`}
        className="adm-entity-panel"
        role="group"
        aria-label={typeName}
        hidden={!open}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setOpen(false);
            button.current?.focus();
          }
        }}
      >
        <p className="adm-entity-type">{typeName}</p>
        {label ? (
          <p className="adm-entity-name">
            <Bidi>{label}</Bidi>
          </p>
        ) : null}
        <p className="adm-muted">
          <Bidi ltr>{id}</Bidi>
        </p>
        {preview ? <div className="adm-entity-preview">{preview}</div> : null}
        {href ? (
          <Link href={href} className="adm-entity-open">
            {t('admin.kit.entity.open')}
          </Link>
        ) : null}
      </div>
    </span>
  );
}

export interface TimelineItem {
  id: string;
  at: string;
  title: ReactNode;
  actor?: string;
  detail?: ReactNode;
}

/** Events in time order (oldest first), each with its time and who did it. */
export function Timeline({ items, label }: { items: readonly TimelineItem[]; label?: string }) {
  const t = useT();
  const f = useFormat();
  if (!items.length) return <p className="adm-muted">{t('admin.kit.timeline.empty')}</p>;
  return (
    <ol className="adm-timeline" aria-label={label ?? t('admin.kit.timeline.label')} data-kit="timeline">
      {items.map((i) => (
        <li key={i.id}>
          <p className="adm-timeline-head">
            <time dateTime={i.at}>{f.date(i.at, 'dateTime')}</time>
            {i.actor ? (
              <span className="adm-muted">
                {' · '}
                <Bidi>{i.actor}</Bidi>
              </span>
            ) : null}
          </p>
          <div className="adm-timeline-title">{i.title}</div>
          {i.detail ? <div className="adm-timeline-detail">{i.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}

export interface AiEvidenceProps {
  /** What the AI produced, e.g. "Risk assessment". */
  title: string;
  riskScore?: number | null;
  reasons?: readonly string[];
  model?: string | null;
  promptVersion?: string | null;
  /** The MCP access log entry that produced it (ADM can open it, others see the id). */
  mcpLogId?: string | null;
}

/** AI output as a labelled input to a human decision (Docs/23 principle 3): never a decision of its own. */
export function AiEvidenceBlock({ title, riskScore, reasons, model, promptVersion, mcpLogId }: AiEvidenceProps) {
  const t = useT();
  const f = useFormat();
  const session = useSession();
  const canOpenLog = canCall('admin.mcp_access_log_search', session.data?.staff?.roles ?? []);
  return (
    <aside className="adm-ai" aria-label={t('admin.kit.ai.label')} data-kit="ai-evidence">
      <p className="adm-ai-head">
        <Badge tone="accent" icon="spark">
          {t('admin.kit.ai.badge')}
        </Badge>
        <span className="adm-ai-title">{title}</span>
        {riskScore != null ? <span className="adm-ai-score">{t('admin.kit.ai.risk', { score: f.number(riskScore) })}</span> : null}
      </p>
      <p className="adm-muted">{t('admin.kit.ai.humanDecides')}</p>
      {reasons?.length ? (
        <ul className="adm-ai-reasons">
          {reasons.map((r) => (
            <li key={r}>
              <Bidi>{r}</Bidi>
            </li>
          ))}
        </ul>
      ) : null}
      <dl className="adm-ai-meta">
        <div>
          <dt>{t('admin.kit.ai.model')}</dt>
          <dd>
            <Bidi ltr>{model ?? '—'}</Bidi>
          </dd>
        </div>
        <div>
          <dt>{t('admin.kit.ai.prompt')}</dt>
          <dd>
            <Bidi ltr>{promptVersion ?? '—'}</Bidi>
          </dd>
        </div>
        {mcpLogId ? (
          <div>
            <dt>{t('admin.kit.ai.log')}</dt>
            <dd>
              {canOpenLog ? (
                <Link href={`/mcp?log=${encodeURIComponent(mcpLogId)}`}>
                  <Bidi ltr>{mcpLogId}</Bidi>
                </Link>
              ) : (
                <Bidi ltr>{mcpLogId}</Bidi>
              )}
            </dd>
          </div>
        ) : null}
      </dl>
    </aside>
  );
}

const SLA_TONE = { ok: 'neutral', warn: 'signal', breach: 'danger' } as const;
const SLA_ICON: Record<SlaState, IconName> = { ok: 'clock', warn: 'alert', breach: 'alert' };

/** An SLA state in words and colour (colour is never the only signal). */
export function SlaBadge({ state, text }: { state: SlaState; text?: string }) {
  const t = useT();
  return (
    <span data-kit="sla" data-sla={state}>
      <Badge tone={SLA_TONE[state]} icon={SLA_ICON[state]}>
        {text ?? t(`admin.kit.sla.${state}`)}
      </Badge>
    </span>
  );
}
