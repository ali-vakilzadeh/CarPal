// Server inputs of the search and map pages (P6): the chosen city (?city, the landing's cp_city cookie, else the
// region's first city) and the page's map style (map-config.ts). The search pages never read search text or
// coordinates from the request — there are none in their URLs (GD-14).
import 'server-only';
import { cookies } from 'next/headers';
import { CITY_COOKIE } from '@/features/landing/city-cookie';
import type { PageContext } from './page-context';

export async function chosenCity(
  ctx: Pick<PageContext, 'region'>,
  asked?: string | string[],
): Promise<{ city: string; fromDefault: boolean }> {
  const keys = ctx.region.cities.map((c) => c.city_key);
  const fromQuery = typeof asked === 'string' && keys.includes(asked) ? asked : null;
  const fromCookie = (await cookies()).get(CITY_COOKIE)?.value;
  const city = fromQuery ?? (fromCookie && keys.includes(fromCookie) ? fromCookie : null);
  return city ? { city, fromDefault: false } : { city: keys[0] ?? 'tehran', fromDefault: true };
}
