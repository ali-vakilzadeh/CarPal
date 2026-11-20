'use client';
// Charts of the console (AC13.T5, dataviz rules): one metric per chart (single series: the title names it, no legend),
// thin marks from one baseline, hairline grid and axes, colours from the design-system tokens (series --accent, grid
// --divider, text --ink / --ink-muted; D-90). Counts are daily columns (24 px at most, 4 px rounded data end, square at
// the baseline, 2 px surface gap); gauges are a 2 px line with an end dot ringed in the surface colour. A crosshair
// follows the pointer and the arrow keys (the chart is one focusable figure) and a tooltip shows the day's value; the
// same values are in the table under every chart, so the tooltip never gates a value. In Persian the time axis runs
// from right to left (the SVG is mirrored in code; CSS stays logical).
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useFormat } from '@/lib/format/client';
import { useLocale, useT } from '@/lib/i18n/client';
import { dailySeries, gaugeDay, hasData, metricKind, metricValue, niceTicks, type DashboardMetric, type DayRange } from './analytics-logic';

const PLOT_H = 132;
const AXIS_H = 22;
const GUTTER = 44;
const PAD = 8;
const BAR_MAX = 24;
const FALLBACK_W = 480;

/** The rendered width of an element (ResizeObserver; jsdom has none, so tests use the fallback). */
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(FALLBACK_W);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/** A column with a 4 px rounded top and a square foot on the baseline. */
function columnPath(x: number, y: number, w: number, base: number): string {
  const r = Math.min(4, w / 2, (base - y) / 2);
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

export interface StatTileProps {
  label: string;
  value: string;
  /** The period or the day the value is from. */
  note?: ReactNode;
  testId?: string;
}

/** A number with its label (proportional figures; no chart for a single value). */
export function StatTile({ label, value, note, testId }: StatTileProps) {
  return (
    <div className="adm-stat" data-testid={testId}>
      <p className="adm-stat-label">{label}</p>
      <p className="adm-stat-value">{value}</p>
      {note ? <p className="adm-muted adm-stat-note">{note}</p> : null}
    </div>
  );
}

export interface MetricChartProps {
  metric: DashboardMetric;
  range: DayRange;
  title: string;
  /** Hold the last drawing at reduced opacity while new numbers load. */
  refreshing?: boolean;
}

/** A metric's figure: its total (counts) or latest reading (gauges), the daily chart and the table behind it. */
export function MetricChart({ metric, range, title, refreshing }: MetricChartProps) {
  const t = useT();
  const f = useFormat();
  const kind = metricKind(metric.metric_key);
  const points = useMemo(() => dailySeries(metric, range), [metric, range]);
  const asOf = kind === 'gauge' ? gaugeDay(metric) : null;
  const value = metricValue(metric);
  const empty = !hasData(metric);
  const headline =
    kind === 'gauge'
      ? asOf
        ? t('admin.analytics.chart.asOf', { value: f.number(value), day: f.calendarDate(asOf, 'dateShort') })
        : t('admin.analytics.chart.noReading')
      : t('admin.analytics.chart.total', { value: f.number(value) });
  return (
    <figure
      className="adm-chart"
      data-metric={metric.metric_key}
      data-kind={kind}
      data-state={empty ? 'empty' : 'ready'}
      data-refreshing={refreshing ? 'true' : undefined}
    >
      <figcaption className="adm-chart-head">
        <span className="adm-chart-title">{title}</span>
        <span className="adm-chart-value">{headline}</span>
      </figcaption>
      {empty ? (
        <p className="adm-chart-empty" role="status">
          {kind === 'gauge' ? t('admin.analytics.chart.noReading') : t('admin.analytics.chart.empty')}
        </p>
      ) : (
        <>
          <Plot points={points} kind={kind} title={title} />
          <details className="adm-chart-table">
            <summary>{t('admin.analytics.chart.table')}</summary>
            <table>
              <caption className="sr-only">{title}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('admin.analytics.chart.day')}</th>
                  <th scope="col">{kind === 'gauge' ? t('admin.analytics.chart.reading') : t('admin.analytics.chart.count')}</th>
                </tr>
              </thead>
              <tbody>
                {points.map((p) => (
                  <tr key={p.date}>
                    <td>{f.calendarDate(p.date)}</td>
                    <td>{p.value === null ? '—' : f.number(p.value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </>
      )}
    </figure>
  );
}

function Plot({ points, kind, title }: { points: ReturnType<typeof dailySeries>; kind: 'count' | 'gauge'; title: string }) {
  const t = useT();
  const f = useFormat();
  const rtl = useLocale() === 'fa';
  const uid = useId();
  const [box, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);

  const max = Math.max(0, ...points.map((p) => p.value ?? 0));
  const ticks = niceTicks(max);
  const top = ticks.at(-1) || 1;
  const n = points.length;
  const plotW = Math.max(40, width - GUTTER - PAD);
  // The value axis sits on the inline-start side; days run with the reading direction.
  const x0 = rtl ? PAD : GUTTER;
  const band = plotW / Math.max(n, 1);
  const centre = (i: number) => (rtl ? x0 + plotW - (i + 0.5) * band : x0 + (i + 0.5) * band);
  const y = (v: number) => PAD + PLOT_H - (v / top) * PLOT_H;
  const base = y(0);
  const barW = Math.max(1, Math.min(BAR_MAX, band - 2));

  const nearest = (clientX: number, rect: DOMRect) => {
    const local = ((clientX - rect.left) / rect.width) * width;
    const i = Math.floor((rtl ? x0 + plotW - local : local - x0) / band);
    return Math.min(n - 1, Math.max(0, i));
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const later = rtl ? 'ArrowLeft' : 'ArrowRight';
    const earlier = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (e.key !== later && e.key !== earlier && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    setActive((a) => {
      if (e.key === 'Home') return 0;
      if (e.key === 'End') return n - 1;
      const from = a ?? n - 1;
      return Math.min(n - 1, Math.max(0, from + (e.key === later ? 1 : -1)));
    });
  };

  const line = useMemo(() => {
    if (kind !== 'gauge') return '';
    let d = '';
    let pen = false;
    points.forEach((p, i) => {
      if (p.value === null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${centre(i).toFixed(1)},${y(p.value).toFixed(1)}`;
      pen = true;
    });
    return d;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- geometry follows the inputs listed
  }, [points, kind, width, rtl, top]);
  const lastIndex = points.findLastIndex((p) => p.value !== null);

  const sel = active === null ? null : points[active];
  const first = points[0]!;
  const last = points[n - 1]!;
  const summary = t('admin.analytics.chart.summary', {
    name: title,
    from: f.calendarDate(first.date),
    to: f.calendarDate(last.date),
    max: f.number(max),
  });
  const tipStart = active === null ? 0 : Math.min(Math.max(centre(active) - 60, 0), Math.max(0, width - 120));

  return (
    <div
      ref={box}
      className="adm-chart-plot"
      tabIndex={0}
      role="img"
      aria-label={summary}
      aria-describedby={sel ? `${uid}-tip` : undefined}
      onKeyDown={onKey}
      onFocus={() => setActive((a) => a ?? n - 1)}
      onBlur={() => setActive(null)}
      onPointerMove={(e) => setActive(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
      onPointerLeave={() => setActive(null)}
    >
      <svg width={width} height={PLOT_H + PAD + AXIS_H} aria-hidden="true" focusable="false">
        {ticks.map((v) => (
          <g key={v}>
            <line className={v === 0 ? 'adm-chart-base' : 'adm-chart-grid'} x1={x0} x2={x0 + plotW} y1={y(v)} y2={y(v)} />
            <text className="adm-chart-tick" x={rtl ? x0 + plotW + 6 : GUTTER - 6} y={y(v)} dy="0.32em" textAnchor={rtl ? 'start' : 'end'}>
              {f.number(v, { notation: 'compact', maximumFractionDigits: 1 })}
            </text>
          </g>
        ))}
        {kind === 'count'
          ? points.map((p, i) =>
              p.value && p.value > 0 ? (
                <path
                  key={p.date}
                  className="adm-chart-bar"
                  data-active={i === active ? 'true' : undefined}
                  d={columnPath(centre(i) - barW / 2, y(p.value), barW, base)}
                />
              ) : null,
            )
          : null}
        {kind === 'gauge' && line ? <path className="adm-chart-line" d={line} /> : null}
        {kind === 'gauge' && lastIndex >= 0 ? (
          <circle className="adm-chart-dot" cx={centre(lastIndex)} cy={y(points[lastIndex]!.value!)} r={4} />
        ) : null}
        {active !== null ? <line className="adm-chart-cross" x1={centre(active)} x2={centre(active)} y1={PAD} y2={base} /> : null}
        {kind === 'gauge' && active !== null && points[active]!.value !== null ? (
          <circle className="adm-chart-dot" cx={centre(active)} cy={y(points[active]!.value!)} r={4} />
        ) : null}
        <text className="adm-chart-tick" x={centre(0)} y={base + AXIS_H - 6} textAnchor="middle">
          {f.calendarDate(first.date, 'dateShort')}
        </text>
        {n > 1 ? (
          <text className="adm-chart-tick" x={centre(n - 1)} y={base + AXIS_H - 6} textAnchor="middle">
            {f.calendarDate(last.date, 'dateShort')}
          </text>
        ) : null}
      </svg>
      {sel ? (
        <div id={`${uid}-tip`} className="adm-chart-tip" style={{ insetInlineStart: rtl ? width - tipStart - 120 : tipStart }}>
          <strong>{sel.value === null ? t('admin.analytics.chart.noReadingDay') : f.number(sel.value)}</strong>
          <span>{f.calendarDate(sel.date)}</span>
        </div>
      ) : null}
    </div>
  );
}
