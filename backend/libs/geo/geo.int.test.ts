// distanceMeters and round2 must equal core.distance_m() and numeric round(x, 2).
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '#libs/config/index.js';
import { distanceMeters, round2 } from './index.js';

const config = loadConfig();
const client = new pg.Client({
  host: config.db.host,
  port: config.db.port,
  database: config.db.name,
  user: 'carpal_api',
  password: config.db.passwords.carpal_api,
});
beforeAll(() => client.connect());
afterAll(() => client.end());

describe('geo parity with the database', () => {
  it('matches core.distance_m and round(numeric, 2)', async () => {
    const points = [
      [35.6892, 51.389, 35.8327, 50.9915],
      [35.699739, 51.338097, 35.699739, 51.338097],
      [-33.86882, 151.209296, 51.507351, -0.127758],
      [35.705, -51.005, 35.715, -51.015],
    ];
    for (const [a, b, c, d] of points) {
      const { rows } = await client.query<{ m: number; r1: string; r2: string }>(
        'SELECT core.distance_m($1, $2, $3, $4) AS m, round($1::numeric(9,6), 2)::text AS r1, round($4::numeric(9,6), 2)::text AS r2',
        [a, b, c, d],
      );
      expect(distanceMeters({ lat: a!, lng: b! }, { lat: c!, lng: d! })).toBe(rows[0]!.m);
      expect(round2(a!)).toBe(Number(rows[0]!.r1));
      expect(round2(d!)).toBe(Number(rows[0]!.r2));
    }
  });
});
