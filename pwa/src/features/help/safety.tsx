'use client';
// W-HELP-01 Safety and urgency (P10.T2; Docs/55 C-HELP-05, §5.2): the case's urgency — the user's choice, the
// triage's level and the server's safety block, whichever is highest (the server block always wins over a lower
// choice). Safety-critical interrupts: stop-driving instructions, Find urgent help, Save and decide later, and normal
// results only after "I understand the risk" (the acknowledgment is kept with the case). Other levels show what the
// level means. Never says "safe to ignore"; never a diagnosis. Save and decide later turns the triage into an open
// issue in the garage (triage.complete create_issue) and leaves.
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Check } from '@/components/ds/check';
import { Icon } from '@/components/ds/icon';
import { Urgency } from '@/components/ds/urgency';
import { useToast } from '@/components/shell/toast';
import { uiLevelOf } from '@/features/appointments';
import { useLocale, useT } from '@/lib/i18n/client';
import { useHelpActions } from './actions';
import { caseLevel, isCritical } from './model';
import type { WizardContext } from './wizard';

export function SafetyStep({ ctx }: { ctx: WizardContext }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const { saveIssue } = useHelpActions();
  const { c, triage } = ctx;
  const level = caseLevel(c, triage);
  const critical = isCritical(level);
  const [ack, setAck] = useState(c.ack);
  const [saving, setSaving] = useState(false);

  const saveForLater = async () => {
    setSaving(true);
    try {
      if (triage && !c.issueId) {
        const done = await saveIssue(triage);
        ctx.patch({ issueId: done.issue_id ?? c.issueId });
        toast(t('help.safety.savedIssue'));
      } else toast(t('help.exit.saved'));
      router.push(`/${locale}/home`);
    } catch {
      setSaving(false);
      toast(t('help.errors.failed'));
    }
  };

  const recommendations = (o: { ack?: boolean } = {}) => {
    if (o.ack) ctx.patch({ ack: true });
    ctx.go('recommendations');
  };

  return (
    <div className="pwa-stack">
      {c.aiOff ? <Banner tone="warn" title={t('help.aiOff.title')} text={t('help.aiOff.next')} /> : null}
      {critical ? (
        <>
          <section className="pwa-help-level is-critical" role="alert" aria-labelledby="help-level">
            <div className="pwa-help-level-head">
              <span className="pwa-help-level-icon" aria-hidden="true">
                <Icon name="alert" />
              </span>
              <h1 id="help-level" className="pwa-text-title m-0">
                {t('help.safety.critical')}
              </h1>
            </div>
            <p className="pwa-text-body m-0">{t('help.safety.instructions')}</p>
            <ul className="pwa-help-list">
              <li>{t('help.safety.stop')}</li>
              <li>{t('help.safety.pullOver')}</li>
              <li>{t('help.safety.dontIgnore')}</li>
              <li>{t('help.safety.towing')}</li>
            </ul>
          </section>
          <div className="pwa-stack-sm">
            <Button variant="danger" icon="alert" block onClick={() => recommendations()}>
              {t('help.safety.findUrgent')}
            </Button>
            <Button variant="ghost" icon="bookmark" block loading={saving} onClick={() => void saveForLater()}>
              {t('help.safety.saveLater')}
            </Button>
          </div>
          <div className="pwa-card pwa-stack-sm">
            <Check checked={ack} onChange={(e) => setAck(e.target.checked)}>
              {t('help.safety.ack')}
            </Check>
            <div>
              <Button size="sm" disabled={!ack} onClick={() => recommendations({ ack: true })}>
                {t('help.safety.seeRecommendations')}
              </Button>
            </div>
          </div>
        </>
      ) : (
        <>
          <section className={`pwa-help-level is-${uiLevelOf(level)}`} aria-labelledby="help-level">
            <span className="pwa-text-caption">{t('help.safety.urgency')}</span>
            <h1 id="help-level" className="pwa-text-title m-0">
              <Urgency level={uiLevelOf(level)} label={t(`appointments.urgency.${level}`)} />
            </h1>
            <p className="pwa-text-body m-0">{t(`help.safety.level.${level}`)}</p>
          </section>
          <div className="pwa-stack-sm">
            <Button variant="primary" icon="next" block onClick={() => recommendations()}>
              {t('help.safety.seeRecommendations')}
            </Button>
            <Button variant="ghost" icon="bookmark" block loading={saving} onClick={() => void saveForLater()}>
              {t('help.safety.saveLater')}
            </Button>
          </div>
        </>
      )}
      <p className="pwa-text-caption m-0">{t('help.questions.notDiagnosis')}</p>
    </div>
  );
}
