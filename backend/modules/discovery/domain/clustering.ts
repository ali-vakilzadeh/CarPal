// Map clustering by zoom (40 §14.1 MapResponse, 54 §5.5): pins stay single
// while few enough are in view; otherwise pins sharing a grid cell of about
// 60 screen pixels at the zoom become one cluster with its centroid and the
// zoom at which it splits. Deterministic, no state.

export interface PinPoint {
  id: string;
  point: { lat: number; lng: number };
}

export interface Cluster {
  cluster_id: string;
  point: { lat: number; lng: number };
  count: number;
  expansion_zoom: number;
}

/** Grid cell size in degrees for a zoom (256 px tiles, ~60 px cells). */
export const cellDegrees = (zoom: number): number => (360 / 2 ** zoom) * (60 / 256);

export function cluster<T extends PinPoint>(pins: readonly T[], zoom: number, maxPins = 300): { pins: T[]; clusters: Cluster[] } {
  if (pins.length <= maxPins && zoom >= 12) return { pins: [...pins], clusters: [] };
  const size = cellDegrees(zoom);
  const cells = new Map<string, T[]>();
  for (const p of pins) {
    const key = `${Math.floor(p.point.lat / size)}:${Math.floor(p.point.lng / size)}`;
    cells.set(key, [...(cells.get(key) ?? []), p]);
  }
  const single: T[] = [];
  const clusters: Cluster[] = [];
  for (const [key, members] of [...cells.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (members.length === 1) {
      single.push(members[0]!);
      continue;
    }
    const lat = members.reduce((s, m) => s + m.point.lat, 0) / members.length;
    const lng = members.reduce((s, m) => s + m.point.lng, 0) / members.length;
    clusters.push({
      cluster_id: `z${zoom}:${key}`.slice(0, 40),
      point: { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 },
      count: members.length,
      expansion_zoom: Math.min(22, zoom + 2),
    });
  }
  return { pins: single.slice(0, maxPins), clusters: clusters.slice(0, 300) };
}
