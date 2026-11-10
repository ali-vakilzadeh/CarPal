'use client';
// MaskedField (AC5.T3, Docs/23 §1 principle 4, §3.3): phone, email, full name, VIN, plate and document numbers are
// masked by default ("+98 912 *** 4567"). Reveal is a purpose-bound re-read (the page passes onReveal, which reads the
// record again with the work item's purpose, so the backend logs the access); without a purpose there is no Reveal.
// The revealed value is kept in this component only and hidden again with Hide or when the page changes. Renders a
// <dt>/<dd> pair: place it inside a <dl>.
import { useId, useState } from 'react';
import { Button } from '@/components/ds/button';
import { Bidi } from '@/lib/format/bidi';
import type { ApiProblem } from '@/lib/api/problem';
import { useT } from '@/lib/i18n/client';
import { problemText } from './four-eyes-banner';

export type MaskKind = 'phone' | 'email' | 'name' | 'vin' | 'plate' | 'text';

const STARS = '***';

/** +98 912 *** 4567: the country code (two digits) and the first three digits stay, then the last four. */
export function maskPhone(v: string): string {
  const d = v.replace(/[^\d+]/g, '');
  const cc = /^\+\d{2}/.exec(d)?.[0] ?? '';
  const rest = d.slice(cc.length).replace(/\D/g, '');
  if (rest.length < 8) return STARS;
  return `${cc ? `${cc} ` : ''}${rest.slice(0, 3)} ${STARS} ${rest.slice(-4)}`;
}

/** m***@e***.com */
export function maskEmail(v: string): string {
  const at = v.lastIndexOf('@');
  if (at < 1) return STARS;
  const local = v.slice(0, at);
  const domain = v.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${local[0]}${STARS}@${host[0] ?? ''}${STARS}${tld}`;
}

/** M*** K***: the first letter of each word. */
export function maskName(v: string): string {
  const words = v.trim().split(/\s+/).filter(Boolean);
  return words.length ? words.map((w) => `${[...w][0]}${STARS}`).join(' ') : STARS;
}

/** The last n characters stay: VIN 4, plate 2. */
export function maskTail(v: string, keep: number): string {
  const chars = [...v.replace(/\s+/g, '')];
  if (chars.length <= keep) return STARS;
  return `${STARS}${chars.slice(-keep).join('')}`;
}

export function maskValue(kind: MaskKind, v: string): string {
  switch (kind) {
    case 'phone':
      return maskPhone(v);
    case 'email':
      return maskEmail(v);
    case 'name':
      return maskName(v);
    case 'vin':
      return maskTail(v, 4);
    case 'plate':
      return maskTail(v, 2);
    default:
      return STARS;
  }
}

/** Values that keep their left-to-right order inside Persian text. */
const LTR_KINDS: ReadonlySet<MaskKind> = new Set(['phone', 'email', 'vin', 'plate']);

export interface MaskedFieldProps {
  label: string;
  kind: MaskKind;
  /** The value from the record, or null when the record has none. */
  value: string | null;
  /** The purpose-bound re-read; resolves to the value to show. Without it there is no Reveal (no purpose). */
  onReveal?: () => Promise<string | null>;
}

export function MaskedField({ label, kind, value, onReveal }: MaskedFieldProps) {
  const t = useT();
  const id = useId();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<ApiProblem | null>(null);
  const ltr = LTR_KINDS.has(kind);

  const reveal = async () => {
    if (!onReveal) return;
    setBusy(true);
    setProblem(null);
    try {
      setRevealed((await onReveal()) ?? '');
    } catch (err) {
      setProblem(err as ApiProblem);
    } finally {
      setBusy(false);
    }
  };

  const shown = revealed ?? (value ? maskValue(kind, value) : null);
  return (
    <div className="adm-masked" data-kit="masked-field" data-revealed={revealed !== null ? 'true' : 'false'}>
      <dt id={`${id}-l`}>{label}</dt>
      <dd aria-labelledby={`${id}-l`}>
        {shown === null ? (
          <span className="adm-muted">{t('admin.kit.masked.none')}</span>
        ) : (
          <Bidi ltr={ltr} className="adm-masked-value">
            {shown}
          </Bidi>
        )}
        {value !== null ? (
          revealed !== null ? (
            <Button size="sm" variant="ghost" icon="eye" onClick={() => setRevealed(null)}>
              {t('admin.kit.masked.hide')}
            </Button>
          ) : onReveal ? (
            <Button size="sm" variant="ghost" icon="eye" loading={busy} onClick={() => void reveal()} aria-describedby={`${id}-h`}>
              {t('admin.kit.masked.reveal')}
            </Button>
          ) : (
            <span className="adm-muted adm-masked-hint">{t('admin.kit.masked.noPurpose')}</span>
          )
        ) : null}
        {onReveal && revealed === null ? (
          <span id={`${id}-h`} className="sr-only">
            {t('admin.kit.masked.logged')}
          </span>
        ) : null}
        {problem ? (
          <span className="adm-error" role="alert">
            {problemText(problem, t)}
          </span>
        ) : null}
      </dd>
    </div>
  );
}
