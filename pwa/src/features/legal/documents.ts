// The published legal texts (P13.T7) parsed once per process. Import this module from server code, or load it with
// import() in the browser (the sign-up "Read" dialog), so the 60 KB of text never lands in a shared client bundle.
import { LEGAL_TEXTS } from './generated/texts';
import type { LegalKind } from './legal-text';
import { legalDocument, type LegalDocument } from './markdown';

export const LEGAL_VERSIONS: Record<LegalKind, string> = { privacy: LEGAL_TEXTS.privacy.version, terms: LEGAL_TEXTS.terms.version };

const parsed = new Map<LegalKind, LegalDocument>();

export function legalDoc(kind: LegalKind): LegalDocument {
  let doc = parsed.get(kind);
  if (!doc) parsed.set(kind, (doc = legalDocument(LEGAL_TEXTS[kind].markdown)));
  return doc;
}
