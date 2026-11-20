'use client';
// The time window inside an audited search form (presets, or typed days on the viewer's clock, at most 93 days).
import { useId } from 'react';
import { useT } from '@/lib/i18n/client';
import type { MessageKey } from '@/lib/i18n/keys';
import { checkWindow, isWindowPreset, WINDOW_PRESETS, type WindowPreset } from './search-window';

export interface WindowDraft {
  choice: WindowPreset | 'days';
  from: string;
  to: string;
}

export const windowDraftProblem = (d: WindowDraft) => (d.choice === 'days' ? checkWindow(d.from, d.to) : null);

export function WindowField({ draft, onChange, tried }: { draft: WindowDraft; onChange: (d: WindowDraft) => void; tried: boolean }) {
  const t = useT();
  const uid = useId();
  const problem = windowDraftProblem(draft);
  return (
    <>
      <div className="adm-filter">
        <label htmlFor={`${uid}-window`}>{t('admin.audit.window.label')}</label>
        <select
          id={`${uid}-window`}
          className="adm-select"
          value={draft.choice}
          onChange={(e) => {
            const v = e.target.value;
            onChange({ ...draft, choice: isWindowPreset(v) ? v : 'days' });
          }}
        >
          {WINDOW_PRESETS.map((p) => (
            <option key={p} value={p}>
              {t(`admin.audit.window.last${p}` as MessageKey)}
            </option>
          ))}
          <option value="days">{t('admin.audit.window.days')}</option>
        </select>
      </div>
      {draft.choice === 'days' ? (
        <>
          <div className="adm-filter">
            <label htmlFor={`${uid}-from`}>{t('admin.analytics.period.from')}</label>
            <input
              id={`${uid}-from`}
              type="date"
              className="adm-input"
              dir="ltr"
              value={draft.from}
              onChange={(e) => onChange({ ...draft, from: e.target.value })}
            />
          </div>
          <div className="adm-filter">
            <label htmlFor={`${uid}-to`}>{t('admin.analytics.period.to')}</label>
            <input
              id={`${uid}-to`}
              type="date"
              className="adm-input"
              dir="ltr"
              value={draft.to}
              onChange={(e) => onChange({ ...draft, to: e.target.value })}
            />
          </div>
        </>
      ) : null}
      {tried && problem ? (
        <p className="adm-error adm-search-problem" role="alert">
          {t(`admin.audit.window.problem.${problem}` as MessageKey)}
        </p>
      ) : null}
    </>
  );
}
