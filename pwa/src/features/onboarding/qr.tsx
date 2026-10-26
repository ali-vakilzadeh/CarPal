'use client';
// QR code (uqr, no dependencies) drawn as one SVG path in the ink colour: crisp at any size, no canvas, no inline
// styles (CSP), and readable in every theme because the quiet zone keeps the card's surface behind it.
import { encode } from 'uqr';
import { useMemo } from 'react';

export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { size, path } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 2 });
    let d = '';
    qr.data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { size: qr.size, path: d };
  }, [value]);
  return (
    <svg viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} className={className} shapeRendering="crispEdges">
      <rect width={size} height={size} className="pwa-qr-ground" />
      <path d={path} className="pwa-qr-dots" />
    </svg>
  );
}
