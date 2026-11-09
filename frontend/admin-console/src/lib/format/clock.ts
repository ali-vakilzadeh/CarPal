// A countdown as m:ss in the page's digits (AC4: the sign-in pause, the idle warning).
export function clock(seconds: number, digits: (v: string) => string): string {
  const s = Math.max(0, Math.ceil(seconds));
  return digits(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
}
