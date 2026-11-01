// The Privacy Policy and User Agreement pages (/<locale>/privacy, /<locale>/terms; P13.T7, OQ-15). Server component:
// the page title in the UI language, a note in Persian that the text is English only for now, the contents (one link
// per section) and the text itself, then the support address and the other text.
import type { Locale } from '@/lib/i18n/locales';
import type { Translate } from '@/lib/i18n/keys';
import { legalDoc } from './documents';
import { LegalBody, type LegalFill, type LegalKind } from './legal-text';

export const LEGAL_PATH: Record<LegalKind, string> = { privacy: 'privacy', terms: 'terms' };
export const legalPath = (locale: Locale, kind: LegalKind) => `/${locale}/${LEGAL_PATH[kind]}`;

export function LegalPage({ kind, locale, t, fill }: { kind: LegalKind; locale: Locale; t: Translate; fill: LegalFill }) {
  const doc = legalDoc(kind);
  const other: LegalKind = kind === 'privacy' ? 'terms' : 'privacy';
  return (
    <article className="pwa-landing pwa-prose pwa-legal" aria-labelledby="legal-title">
      <header className="pwa-stack-sm">
        <p className="pwa-text-caption m-0">{t(`shell.legal.${kind}`)}</p>
        <h1 id="legal-title" className="pwa-text-title m-0" lang="en" dir="ltr">
          {doc.title}
        </h1>
        {locale !== 'en' ? <p className="pwa-legal-note pwa-text-body m-0">{t('shell.legal.englishOnly')}</p> : null}
      </header>
      <nav aria-labelledby="legal-contents" className="pwa-legal-contents">
        <h2 id="legal-contents" className="pwa-text-label m-0">
          {t('shell.legal.contents')}
        </h2>
        <ol lang="en" dir="ltr">
          {doc.sections.map((s) => (
            <li key={s.id}>
              <a className="pwa-link" href={`#${s.id}`}>
                {s.text}
              </a>
            </li>
          ))}
        </ol>
      </nav>
      <LegalBody doc={doc} fill={fill} />
      <footer className="pwa-stack-sm">
        <p className="pwa-text-body m-0">
          {t('shell.legal.questions')}{' '}
          <a className="pwa-link" href={`mailto:${fill.supportEmail}`} dir="ltr">
            {fill.supportEmail}
          </a>
        </p>
        <p className="pwa-text-body m-0">
          <a className="pwa-link" href={legalPath(locale, other)}>
            {t(`shell.legal.${other}`)}
          </a>
        </p>
      </footer>
    </article>
  );
}
