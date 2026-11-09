/** Joins the truthy class names (the bundle's cx()). */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
