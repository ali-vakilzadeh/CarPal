// The landing page's remembered city (region city_key). A plain module: server components read the constant, and
// a constant exported from a 'use client' file would reach them as a client reference, not the string.
export const CITY_COOKIE = 'cp_city';
