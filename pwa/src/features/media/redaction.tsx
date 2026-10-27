'use client';
// Plate and face redaction (P7.T2, Docs/40 media.redaction_decide, SEC-AI-3): when the API has suggested regions for
// an image (MediaAsset.redaction_status 'suggested'), the owner decides — blur what was found, or keep the photo as it
// is. The decision runs as a job (202 Job, polled through jobs.get). Today the backend suggests regions only for
// organization showcase images (backend media.module), so consumer uploads rarely show this.
import type { MediaAsset } from '@carpal/api-contracts';
import { useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { useApiClient } from '@/lib/api/query';
import { useT } from '@/lib/i18n/client';

export function RedactionChoice({ asset, onDone }: { asset: MediaAsset; onDone?: (decision: 'apply_suggestions' | 'not_needed') => void }) {
  const t = useT();
  const api = useApiClient();
  const [busy, setBusy] = useState<null | 'apply_suggestions' | 'not_needed'>(null);
  const [state, setState] = useState<'ask' | 'done' | 'failed'>('ask');
  if (asset.redaction_status !== 'suggested') return null;
  const decide = async (decision: 'apply_suggestions' | 'not_needed') => {
    setBusy(decision);
    try {
      let job = await api.api('media.redaction_decide', { path: { media_id: asset.id }, body: { decision } });
      for (let i = 0; i < 30 && (job.status === 'queued' || job.status === 'running'); i++) {
        await new Promise((r) => setTimeout(r, 1_000));
        job = await api.api('jobs.get', { path: { job_id: job.id } });
      }
      setState(job.status === 'failed' || job.status === 'cancelled' ? 'failed' : 'done');
      onDone?.(decision);
    } catch {
      setState('failed');
    } finally {
      setBusy(null);
    }
  };
  if (state === 'done') return <Banner tone="success" text={t('media.redaction.done')} />;
  return (
    <Banner tone="info" icon="eye" title={t('media.redaction.title')} text={t('media.redaction.text')}>
      {state === 'failed' ? <p className="pwa-text-caption">{t('media.redaction.failed')}</p> : null}
      <div className="pwa-banner-actions">
        <Button size="sm" loading={busy === 'apply_suggestions'} disabled={!!busy} onClick={() => void decide('apply_suggestions')}>
          {t('media.redaction.apply')}
        </Button>
        <Button size="sm" variant="ghost" loading={busy === 'not_needed'} disabled={!!busy} onClick={() => void decide('not_needed')}>
          {t('media.redaction.keep')}
        </Button>
      </div>
    </Banner>
  );
}
