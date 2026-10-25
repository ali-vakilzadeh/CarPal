import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import {
  MAINTENANCE_RETRY_S,
  MAINTENANCE_UNTIL_HEADER,
  SYSTEM_HEADER,
  maintenanceOf,
  retryAfterSeconds,
  systemRewrite,
} from './system-status';

describe('maintenanceOf', () => {
  const now = Date.parse('2026-10-25T10:00:00Z');
  it('reads off, on and an end time', () => {
    expect(maintenanceOf(undefined, now)).toEqual({ active: false });
    expect(maintenanceOf('off', now)).toEqual({ active: false });
    expect(maintenanceOf('on', now)).toEqual({ active: true, until: null });
    expect(maintenanceOf('2026-10-25T11:30:00Z', now)).toEqual({ active: true, until: '2026-10-25T11:30:00.000Z' });
    expect(maintenanceOf('2026-10-25T09:00:00Z', now)).toEqual({ active: false });
    expect(maintenanceOf('garbled', now)).toEqual({ active: true, until: null });
  });

  it('Retry-After: seconds to the end, at least a minute', () => {
    expect(retryAfterSeconds(null)).toBe(MAINTENANCE_RETRY_S);
    expect(retryAfterSeconds('2026-10-25T10:30:00Z', now)).toBe(1800);
    expect(retryAfterSeconds('2026-10-25T10:00:10Z', now)).toBe(60);
  });
});

describe('systemRewrite', () => {
  const request = new NextRequest('http://localhost:3000/fa/post/1-x');

  it('rewrites to the internal system route with the status and marks the request', () => {
    const res = systemRewrite(request, 'fa', 'gone', new Headers());
    expect(res.status).toBe(410);
    expect(res.headers.get('x-middleware-rewrite')).toBe('http://localhost:3000/fa/system/gone');
    expect(res.headers.get(`x-middleware-request-${SYSTEM_HEADER}`)).toBe('gone');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('retry-after')).toBeNull();
  });

  it('maintenance answers 503 with Retry-After and the end time for the page', () => {
    const res = systemRewrite(request, 'en', 'maintenance', new Headers(), { until: '2099-01-01T00:00:00Z' });
    expect(res.status).toBe(503);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(60);
    expect(res.headers.get(`x-middleware-request-${MAINTENANCE_UNTIL_HEADER}`)).toBe('2099-01-01T00:00:00Z');
  });
});
