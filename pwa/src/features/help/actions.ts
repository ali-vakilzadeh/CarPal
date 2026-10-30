'use client';
// Help Me's server work (P10.T1/T2), in one place so every step does it the same way:
//   - start: triage.start with the description (the server's safety check runs first and always answers, even in the
//     503 AI_UNAVAILABLE body, BA-02); without a car or with ai.triage.enabled off the shared safety.check runs
//     instead and the category path follows (GD-13);
//   - reply: triage.reply; rerun: an edited answer starts a new session and replays the answers before it (Docs/22
//     "editing reruns from that point" — the contract has no rewind);
//   - match: the recommendations — the triage's own match session (triage.complete find_providers, read back with
//     search.session_get), or a Help Me search (search.run entry_point help_me) with the chosen category or the
//     triage's symptom and likely systems as chips, for the AI-off path, a changed category or a new location.
import type { IntentChip, LocationInput, ResultCard, SafetyBlock, SearchRequest, TriageSession, UrgencyLevel } from '@carpal/api-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { ApiProblem } from '@/lib/api/problem';
import { apiQueryKey, useApiClient, useApiQuery } from '@/lib/api/query';
import { useFlag } from '@/lib/config/client';
import { useLocale } from '@/lib/i18n/client';
import { caseLevel, composeText, stepAfterStart, type CaseSafety, type HelpCase, type HelpStep } from './model';

export const TRIAGE_FLAG = 'ai.triage.enabled';
const OPEN: readonly TriageSession['status'][] = ['in_progress', 'escalated_safety'];

export function triageOpen(s: Pick<TriageSession, 'status'> | null | undefined): boolean {
  return !!s && OPEN.includes(s.status);
}

const triageKey = (id: string) => apiQueryKey('triage.get', { path: { session_id: id } });

/** The case's triage session (kept fresh by the steps that change it). */
export function useTriage(c: Pick<HelpCase, 'triageId'> | null) {
  return useApiQuery('triage.get', c?.triageId ? { path: { session_id: c.triageId } } : undefined, {
    enabled: !!c?.triageId,
    staleTime: 60_000,
  });
}

export interface MatchResult {
  sessionId: string;
  results: ResultCard[];
  safety: SafetyBlock;
}

/** The recommendations' inputs that decide whether an earlier match can be shown again. */
export function matchKey(c: Pick<HelpCase, 'category'>, location: LocationInput, wider = false): string {
  const where = location.mode === 'chosen_city' ? `city:${location.city_key}` : location.mode;
  return `${c.category?.id ?? 'triage'}|${where}|${wider ? 'wide' : 'near'}`;
}

/** search.run body of a Help Me search: the category, else the triage's symptom, likely systems and service. */
export function helpSearch(
  c: Pick<HelpCase, 'category' | 'vehicleId' | 'issueId'>,
  s: Pick<TriageSession, 'symptoms' | 'likely_systems' | 'recommended_service' | 'issue_id'> | null,
  location: LocationInput,
  level: UrgencyLevel,
  locale: 'en' | 'fa',
  wider = false,
): SearchRequest {
  const chip = (kind: IntentChip['kind'], node_id: string, text: string): IntentChip => ({
    kind,
    node_id,
    label: { text, locale },
    removable: true,
  });
  const chips: IntentChip[] = c.category
    ? [chip('service_system', c.category.id, c.category.label)]
    : s
      ? [
          ...s.symptoms.slice(0, 1).map((x) => chip('symptom', x.node_id, x.label.text)),
          ...s.likely_systems.slice(0, 3).map((x) => chip('service_system', x.node_id, x.label.text)),
          ...(s.recommended_service ? [chip('service_task', s.recommended_service.node_id, s.recommended_service.label.text)] : []),
        ]
      : [];
  const issueId = c.issueId ?? s?.issue_id ?? null;
  return {
    search_mode: 'providers',
    entry_point: 'help_me',
    location,
    urgency_level: level,
    limit: 20,
    ...(c.vehicleId ? { vehicle_id: c.vehicleId } : {}),
    ...(issueId ? { issue_id: issueId } : {}),
    ...(chips.length ? { intent_override: { target_type: 'provider', chips } } : {}),
    ...(wider ? { filters: { distance_km: 100 } } : {}),
  };
}

export function useHelpActions() {
  const api = useApiClient();
  const queryClient = useQueryClient();
  const locale = useLocale() as 'en' | 'fa';
  const aiOn = useFlag(TRIAGE_FLAG);

  const remember = useCallback((s: TriageSession) => queryClient.setQueryData(triageKey(s.id), s), [queryClient]);

  const safetyCheck = useCallback(
    async (text: string): Promise<CaseSafety | null> => {
      if (!text.trim()) return null;
      try {
        return await api.api('safety.check', { body: { text: text.slice(0, 3000), locale } });
      } catch {
        return null;
      }
    },
    [api, locale],
  );

  /** Starts (or restarts) the guided help for a case; returns the updated case and the step to show. */
  const start = useCallback(
    async (c: HelpCase, symptomLabels: readonly string[]): Promise<{ c: HelpCase; step: HelpStep }> => {
      const text = composeText(c.text, symptomLabels);
      const reset: HelpCase = { ...c, triageId: null, matchSessionId: null, provider: null, draft: null, ack: false, aiOff: false };
      if (c.vehicleId && aiOn) {
        try {
          const s = await api.api('triage.start', {
            body: { vehicle_id: c.vehicleId, text, locale, ...(c.mediaIds.length ? { media_ids: c.mediaIds.slice(0, 6) } : {}) },
          });
          remember(s);
          const next: HelpCase = { ...reset, triageId: s.id, safety: s.safety };
          return { c: next, step: stepAfterStart(caseLevel(next, s), s) };
        } catch (err) {
          if (!(err instanceof ApiProblem) || err.code !== 'AI_UNAVAILABLE') throw err;
          // AI off (the pilot's expected state, BA-02): the server's safety block still came back.
          return { c: { ...reset, aiOff: true, safety: err.safety ?? (await safetyCheck(text)) }, step: 'safety' };
        }
      }
      return { c: { ...reset, aiOff: !aiOn, safety: await safetyCheck(text) }, step: 'safety' };
    },
    [aiOn, api, locale, remember, safetyCheck],
  );

  const reply = useCallback(
    async (s: TriageSession, text: string): Promise<TriageSession> => {
      const next = await api.api('triage.reply', { path: { session_id: s.id }, body: { text: text.slice(0, 2000) } });
      remember(next);
      return next;
    },
    [api, remember],
  );

  /** A new session with the description and the answers up to an edited one. */
  const rerun = useCallback(
    async (c: HelpCase, startText: string, replies: readonly string[]): Promise<TriageSession> => {
      let s = await api.api('triage.start', {
        body: { vehicle_id: c.vehicleId!, text: startText, locale, ...(c.mediaIds.length ? { media_ids: c.mediaIds.slice(0, 6) } : {}) },
      });
      for (const r of replies) s = await api.api('triage.reply', { path: { session_id: s.id }, body: { text: r.slice(0, 2000) } });
      remember(s);
      return s;
    },
    [api, locale, remember],
  );

  /** The recommendations of a case for a location (see the file comment). */
  const match = useCallback(
    async (
      c: HelpCase,
      s: TriageSession | null,
      location: LocationInput,
      o: { reuse: boolean; wider?: boolean },
    ): Promise<{ result: MatchResult; triage: TriageSession | null }> => {
      const level = caseLevel(c, s);
      if (o.reuse && c.matchSessionId) {
        try {
          const r = await api.api('search.session_get', { path: { session_id: c.matchSessionId }, query: { limit: 20 } });
          return { result: { sessionId: r.session_id, results: r.results, safety: r.safety }, triage: s };
        } catch (err) {
          if (!(err instanceof ApiProblem) || (err.status !== 404 && err.code !== 'CURSOR_MISMATCH')) throw err;
        }
      }
      if (s && triageOpen(s) && !c.category && !o.wider) {
        try {
          const done = await api.api('triage.complete', {
            body: { create_issue: !c.issueId && !s.issue_id, find_providers: true, location },
            path: { session_id: s.id },
          });
          remember(done);
          if (done.match_session_id) {
            const r = await api.api('search.session_get', { path: { session_id: done.match_session_id }, query: { limit: 20 } });
            return { result: { sessionId: r.session_id, results: r.results, safety: r.safety }, triage: done };
          }
          s = done;
        } catch (err) {
          // Completed meanwhile (another match for a new location raced this one): search with its chips instead.
          if (!(err instanceof ApiProblem) || err.code !== 'INVALID_TRANSITION') throw err;
          s = await api.api('triage.get', { path: { session_id: s.id } });
          remember(s);
        }
      }
      const r = await api.api('search.run', { body: helpSearch(c, s, location, level, locale, o.wider) });
      return { result: { sessionId: r.session_id, results: r.results, safety: r.safety }, triage: s };
    },
    [api, locale, remember],
  );

  /** "Save and decide later": the triage becomes an open issue in the garage (once). */
  const saveIssue = useCallback(
    async (s: TriageSession): Promise<TriageSession> => {
      if (!triageOpen(s) || s.issue_id) return s;
      const done = await api.api('triage.complete', { path: { session_id: s.id }, body: { create_issue: true, find_providers: false } });
      remember(done);
      return done;
    },
    [api, remember],
  );

  return { aiOn, start, reply, rerun, match, saveIssue, safetyCheck };
}
