// Hand-over to the ask page (W-QA-02): the hub's "Ask it" and the search page carry the typed text as the question's
// title through sessionStorage (never the URL, GD-14). Kept until the question is posted.
export const ASK_DRAFT_KEY = 'cp:ask-draft';

export interface AskDraft {
  title: string;
}

export function saveAskDraft(d: AskDraft): void {
  try {
    sessionStorage.setItem(ASK_DRAFT_KEY, JSON.stringify({ title: d.title.slice(0, 160) }));
  } catch {
    /* the ask page starts empty */
  }
}

/** The handed-over title, or '' (a primitive, so it can feed useBrowserValue). */
export function peekAskTitle(): string {
  try {
    const raw = sessionStorage.getItem(ASK_DRAFT_KEY);
    const v = raw ? (JSON.parse(raw) as Partial<AskDraft>) : null;
    return v && typeof v.title === 'string' ? v.title : '';
  } catch {
    return '';
  }
}

export function clearAskDraft(): void {
  try {
    sessionStorage.removeItem(ASK_DRAFT_KEY);
  } catch {
    /* ignore */
  }
}
