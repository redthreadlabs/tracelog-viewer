/**
 * Duration-over-time scatter for the transaction drill-down. Each point is
 * one instance; color encodes the result family (ok / client-error /
 * failure). Clicking a point opens its trace waterfall.
 *
 * Points are drawn on a canvas layer (axes stay SVG): a busy transaction
 * has tens of thousands of instances, and one SVG node + listeners per
 * point froze the page for ~25 s at 18k points (perf finding 2026-06-12).
 * Canvas draws them in milliseconds; hover/click hit-test against the
 * x-sorted point array instead of DOM events.
 */
import { select } from 'd3-selection';
import { scaleUtc, scaleTime, scaleLog } from 'd3-scale';
import { axisBottom, axisLeft } from 'd3-axis';
import { el, clear } from '../ui/dom';
import type { Rec } from '../data/types';
import { fmtDateTime, fmtDuration, isUtcMode } from '../ui/format';
import { logTicks, timeTickFormat } from './ticks';

const HEIGHT = 190;
const MARGIN = { top: 8, right: 10, bottom: 24, left: 56 };
const HIT_RADIUS = 8;

import { resultFamily, type ResultFamily } from '../data/aggregate';

export { resultFamily, type ResultFamily };

const FAMILY_TOKEN: Record<ResultFamily, string> = {
  ok: '--kind-span',
  warn: '--level-warn',
  bad: '--thread',
  other: '--ink-faint',
};

const FAMILY_ALPHA: Record<ResultFamily, number> = {
  ok: 0.55,
  warn: 0.9,
  bad: 0.9,
  other: 0.9,
};

export function renderScatter(
  container: HTMLElement,
  instances: Rec[],
  onPick: (rec: Rec) => void,
): void {
  clear(container);
  const points = instances.filter((r) => r.duration !== undefined && r.ts > 0);
  if (points.length === 0) return;

  const width = Math.max(container.clientWidth, 280);
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const styles = getComputedStyle(container); // resolve tokens in the panel scope
  const colorOf = (family: ResultFamily) =>
    styles.getPropertyValue(FAMILY_TOKEN[family]).trim();
  const lineColor = styles.getPropertyValue('--line-strong').trim();
  const inkFaint = styles.getPropertyValue('--ink-faint').trim();

  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  const x = (isUtcMode() ? scaleUtc() : scaleTime())
    .domain([new Date(t0), new Date(t1 === t0 ? t0 + 1000 : t1)])
    .range([0, innerW]);

  let durMin = Infinity;
  let durMax = -Infinity;
  for (const r of points) {
    if (r.duration! < durMin) durMin = r.duration!;
    if (r.duration! > durMax) durMax = r.duration!;
  }
  const yMin = Math.max(durMin, 0.05);
  const yMax = durMax * 1.15;
  const y = scaleLog().domain([yMin, yMax]).range([innerH, 0]);

  container.style.position = 'relative';
  const svg = select(container).append('svg').attr('width', width).attr('height', HEIGHT);
  const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

  g.append('g')
    .attr('transform', `translate(0,${innerH})`)
    .call(
      axisBottom(x)
        .ticks(Math.min(8, Math.max(3, Math.floor(innerW / 110))))
        .tickFormat(timeTickFormat(t1 - t0) as never)
        .tickSizeOuter(0),
    )
    .call((sel) => {
      sel.selectAll('text').attr('fill', inkFaint).style('font', '10.5px var(--font-data)');
      sel.selectAll('line').attr('stroke', lineColor);
      sel.select('.domain').attr('stroke', lineColor);
    });

  g.append('g')
    .call(
      axisLeft(y)
        .tickValues(logTicks(yMin, yMax))
        .tickFormat((v) => fmtDuration(v as number))
        .tickSizeOuter(0),
    )
    .call((sel) => {
      sel.selectAll('text').attr('fill', inkFaint).style('font', '10.5px var(--font-data)');
      sel.selectAll('line').attr('stroke', lineColor);
      sel.select('.domain').attr('stroke', lineColor);
    });

  // --- the points, on canvas ---
  const dpr = window.devicePixelRatio || 1;
  const canvas = el('canvas');
  canvas.width = Math.round(innerW * dpr);
  canvas.height = Math.round(innerH * dpr);
  canvas.style.cssText =
    `position:absolute;left:${MARGIN.left}px;top:${MARGIN.top}px;` +
    `width:${innerW}px;height:${innerH}px`;
  container.append(canvas);

  // pixel positions, in ts order (so px is ascending — binary-searchable)
  const n = points.length;
  const px = new Float32Array(n);
  const py = new Float32Array(n);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  for (let i = 0; i < n; i++) {
    px[i] = x(new Date(points[i].ts));
    py[i] = y(Math.max(points[i].duration!, yMin));
  }
  // one path per family: a fillStyle switch per point is the slow way
  const byFamily = new Map<ResultFamily, number[]>();
  for (let i = 0; i < n; i++) {
    const family = resultFamily(points[i]);
    const list = byFamily.get(family);
    if (list) list.push(i);
    else byFamily.set(family, [i]);
  }
  for (const [family, indices] of byFamily) {
    ctx.beginPath();
    ctx.fillStyle = colorOf(family);
    ctx.globalAlpha = FAMILY_ALPHA[family];
    for (const i of indices) {
      ctx.moveTo(px[i] + 3, py[i]);
      ctx.arc(px[i], py[i], 3, 0, 2 * Math.PI);
    }
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // --- hover/click: nearest point within HIT_RADIUS ---
  const tooltip = el('div', { className: 'chart-tooltip' });
  container.append(tooltip);

  function nearest(mx: number, my: number): number {
    // binary search the x window, then scan it for the closest point
    let lo = 0;
    let hi = n - 1;
    const xLeft = mx - HIT_RADIUS;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (px[mid] < xLeft) lo = mid + 1;
      else hi = mid;
    }
    let best = -1;
    let bestD2 = HIT_RADIUS * HIT_RADIUS;
    for (let i = lo; i < n && px[i] <= mx + HIT_RADIUS; i++) {
      const dx = px[i] - mx;
      const dy = py[i] - my;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  canvas.addEventListener('pointermove', (event) => {
    const box = canvas.getBoundingClientRect();
    const hit = nearest(event.clientX - box.left, event.clientY - box.top);
    canvas.style.cursor = hit === -1 ? 'default' : 'pointer';
    if (hit === -1) {
      tooltip.style.display = 'none';
      return;
    }
    const rec = points[hit];
    tooltip.innerHTML = `<div class="t">${fmtDateTime(rec.ts)}</div><span class="row">${rec.result ?? rec.outcome ?? ''}<span class="v">${fmtDuration(rec.duration!)}</span></span>`;
    tooltip.style.display = 'block';
    const rect = container.getBoundingClientRect();
    tooltip.style.left = `${Math.min(event.clientX - rect.left + 12, width - 190)}px`;
    tooltip.style.top = `${event.clientY - rect.top - 8}px`;
  });
  canvas.addEventListener('pointerleave', () => {
    tooltip.style.display = 'none';
  });
  canvas.addEventListener('click', (event) => {
    const box = canvas.getBoundingClientRect();
    const hit = nearest(event.clientX - box.left, event.clientY - box.top);
    if (hit !== -1) onPick(points[hit]);
  });
}
