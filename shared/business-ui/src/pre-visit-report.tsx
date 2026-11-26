// Pre-visit report as the shop reads it (PRV-GD-08; Workshop PW-REQ-02, Web UI P-REQ-02; Docs/11 Ch.5, Docs/40
// pre_visit.provider_get): the customer's own description, reported symptoms, the AI pre-visit summary labelled as AI
// (or "Triage: not provided" when the request did not come from Help Me), likely services, the customer's
// expectations, the shared service history (or "Not shared by customer" without the service_history_sharing
// consent), warnings, focus areas and the photos and video. The words and the media come from the caller; nothing
// here reads the API.
import type { ReactNode } from 'react';
import { cx } from './cx';

export interface PreVisitWords {
  issue: string;
  symptoms: string;
  aiLabel: string;
  aiNote: string;
  triageNone: string;
  triageNoneText: string;
  likely: string;
  expectations: string;
  history: string;
  historyNotShared: string;
  warnings: string;
  focus: string;
  media: string;
}

export interface PreVisitData {
  /** The customer's own words. */
  issue: string;
  symptoms: readonly string[];
  /** true when the request came from Help Me (triage provided). */
  triage: boolean;
  aiSummary: string | null;
  likely: readonly string[];
  expectations: string | null;
  /** null without the customer's service_history_sharing consent. */
  history: string | null;
  /** Previous related repairs, already formatted ("12 Aug 2025 · Brakes — pads and discs"). */
  previous: readonly string[];
  warnings: readonly string[];
  focus: readonly string[];
  /** Language of the customer's text. */
  lang?: string;
}

export interface PreVisitReportProps {
  words: PreVisitWords;
  data: PreVisitData;
  /** The photos and video, rendered by the app (it knows its media component and signed URLs). */
  media?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
}

export function PreVisitReport({ words, data, media, headingLevel = 3, className }: PreVisitReportProps) {
  const H = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className={cx('bui-previsit', className)}>
      {data.warnings.length ? (
        <section className="bui-previsit-warnings">
          <H className="bui-previsit-title">{words.warnings}</H>
          <ul className="bui-previsit-list">
            {data.warnings.map((w, i) => (
              <li key={i} dir="auto">
                {w}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="bui-previsit-part">
        <H className="bui-previsit-title">{words.issue}</H>
        <p className="bui-previsit-text" dir="auto" lang={data.lang}>
          {data.issue}
        </p>
        {data.symptoms.length ? (
          <ul className="bui-previsit-tags" aria-label={words.symptoms}>
            {data.symptoms.map((s, i) => (
              <li key={i} className="cp-badge cp-badge-neutral">
                {s}
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      {data.triage && data.aiSummary ? (
        <section className="bui-previsit-part bui-previsit-ai">
          <span className="cp-badge cp-badge-accent bui-previsit-ai-label">{words.aiLabel}</span>
          <p className="bui-previsit-text" dir="auto">
            {data.aiSummary}
          </p>
          <p className="bui-previsit-note">{words.aiNote}</p>
        </section>
      ) : !data.triage ? (
        <section className="bui-previsit-part bui-previsit-plain">
          <H className="bui-previsit-title">{words.triageNone}</H>
          <p className="bui-previsit-note">{words.triageNoneText}</p>
        </section>
      ) : null}
      {data.likely.length ? (
        <section className="bui-previsit-part">
          <H className="bui-previsit-title">{words.likely}</H>
          <ul className="bui-previsit-tags">
            {data.likely.map((s, i) => (
              <li key={i} className="cp-badge cp-badge-accent">
                {s}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {data.focus.length ? (
        <section className="bui-previsit-part">
          <H className="bui-previsit-title">{words.focus}</H>
          <p className="bui-previsit-text" dir="auto">
            {data.focus.join(' · ')}
          </p>
        </section>
      ) : null}
      {data.expectations ? (
        <section className="bui-previsit-part">
          <H className="bui-previsit-title">{words.expectations}</H>
          <p className="bui-previsit-text" dir="auto" lang={data.lang}>
            {data.expectations}
          </p>
        </section>
      ) : null}
      <section className="bui-previsit-part" data-history={data.history === null ? 'not-shared' : 'shared'}>
        <H className="bui-previsit-title">{words.history}</H>
        {data.history === null ? (
          <p className="bui-previsit-note">{words.historyNotShared}</p>
        ) : (
          <>
            <p className="bui-previsit-text" dir="auto">
              {data.history}
            </p>
            {data.previous.length ? (
              <ul className="bui-previsit-list">
                {data.previous.map((p, i) => (
                  <li key={i} dir="auto">
                    {p}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </section>
      {media ? (
        <section className="bui-previsit-part">
          <H className="bui-previsit-title">{words.media}</H>
          {media}
        </section>
      ) : null}
    </div>
  );
}
