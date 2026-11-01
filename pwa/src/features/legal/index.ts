// Legal texts (P13.T7): /<locale>/privacy and /<locale>/terms, the sign-up "Read" dialogs and the links to them. The
// texts themselves are in ./documents (server code and import() only).
export { LegalBody, type LegalFill, type LegalKind } from './legal-text';
export { LegalDialogBody } from './legal-dialog';
export { legalDocument, parseMarkdown, type LegalDocument } from './markdown';
