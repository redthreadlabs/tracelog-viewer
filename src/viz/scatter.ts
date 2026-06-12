/**
 * Duration-over-time scatter for the transaction drill-down. Each point is
 * one instance; color encodes the result family (ok / client-error /
 * failure). Clicking a point opens its trace waterfall.
 *
 * Points are drawn on a canvas layer (axes stay SVG): a busy transaction
 * has tens of thousands of instances, and one SVG node + listeners per
 * point froze the page for ~25 s at 18k points (perf finding 2026-06-12).
 * Each point is stamped from a pre-rendered per-family sprite — one giant
 * arc path silently fails to rasterize past ~100k subpaths (observed at
 * tier-10m). Past a point budget the ok-mass is stride-sampled for
 * legibility (it's solid ink anyway) with a caption saying so; warn/error
 * points are always all drawn, and hover/click hit-test the FULL x-sorted
 * point set, not just what's drawn.
 */
import { select } from 'd3-selection';
import { scaleUtc, scaleTime, scaleLog } from 'd3-scale';
import { axisBottom, axisLeft } from 'd3-axis';
import { el, clear } from '../ui/dom';
import type { Rec } from '../data/types';
import { fmtDateTime, fmtDuration, isUtcMode } from '../ui/format';
import { logTicks, timeTickFormat, contentWidth } from './ticks';

const HEIGHT = 190;
const MARGIN = { top: 8, right: 10, bottom: 24, left: 56 };
const HIT_RADIUS = 8;
/** at most this many points stamped (hit-testing still sees them all) */
const MAX_DRAWN = 20_000;
const SPRITE_SIZE = 8; // css px; the r=3 dot plus a pad for antialiasing

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

/** 3 → "3rd", 21 → "21st" — sampling disclosures read like English. */
function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/** A pre-rendered dot: stamping sprites avoids giant paths entirely. */
function makeSprite(color: string, alpha: number, dpr: number): HTMLCanvasElement {
  const sprite = document.createElement('canvas');
  sprite.width = SPRITE_SIZE * dpr;
  sprite.height = SPRITE_SIZE * dpr;
  const sctx = sprite.getContext('2d')!;
  sctx.scale(dpr, dpr);
  sctx.globalAlpha = alpha;
  sctx.fillStyle = color;
  sctx.beginPath();
  sctx.arc(SPRITE_SIZE / 2, SPRITE_SIZE / 2, 3, 0, 2 * Math.PI);
  sctx.fill();
  return sprite;
}

export function renderScatter(
  container: HTMLElement,
  instances: Rec[],
  onPick: (rec: Rec) => void,
  /** where the "(sampled)" pill renders — right-aligned above the chart */
  sampleHost?: HTMLElement,
): void {
  clear(container);
  if (sampleHost) clear(sampleHost);
  const points = instances.filter((r) => r.duration !== undefined && r.ts > 0);
  if (points.length === 0) return;

  const width = contentWidth(container, 280);
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
  // absolute positioning anchors to the padding box; the in-flow svg
  // starts at the content box — offset by the host's padding to match
  const padLeft = parseFloat(styles.paddingLeft) || 0;
  const padTop = parseFloat(styles.paddingTop) || 0;
  canvas.style.cssText =
    `position:absolute;left:${padLeft + MARGIN.left}px;top:${padTop + MARGIN.top}px;` +
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
  const byFamily = new Map<ResultFamily, number[]>();
  for (let i = 0; i < n; i++) {
    const family = resultFamily(points[i]);
    const list = byFamily.get(family);
    if (list) list.push(i);
    else byFamily.set(family, [i]);
  }

  // ok first (the mass), problems stamped on top where they stay visible
  const drawOrder: ResultFamily[] = ['ok', 'other', 'warn', 'bad'];
  const okCount = byFamily.get('ok')?.length ?? 0;
  const alwaysDrawn = n - okCount;
  // sample only the ok-mass, and only past the budget
  const okBudget = Math.max(2000, MAX_DRAWN - alwaysDrawn);
  const okStep = okCount > okBudget ? Math.ceil(okCount / okBudget) : 1;
  let drawn = 0;
  const half = SPRITE_SIZE / 2;
  for (const family of drawOrder) {
    const indices = byFamily.get(family);
    if (!indices) continue;
    const sprite = makeSprite(colorOf(family), FAMILY_ALPHA[family], dpr);
    const step = family === 'ok' ? okStep : 1;
    for (let j = 0; j < indices.length; j += step) {
      const i = indices[j];
      ctx.drawImage(sprite, px[i] - half, py[i] - half, SPRITE_SIZE, SPRITE_SIZE);
      drawn++;
    }
  }
  if (drawn < n && sampleHost) {
    sampleHost.style.position = 'relative';
    const pop = el('div', {
      className: 'chart-tooltip',
      text:
        `Drawing ${drawn.toLocaleString('en-US')} of ${n.toLocaleString('en-US')} points: ` +
        `every ${ordinal(okStep)} successful instance, and every problem instance. ` +
        `Hover and click still consider all points.`,
      attrs: {
        // a drop-up: above the pill row, clear of the chart it describes
        style:
          'right:0;bottom:calc(100% + 8px);width:420px;max-width:420px;' +
          'pointer-events:auto;white-space:normal;line-height:1.5;' +
          'font-size:11px;text-align:justify',
      },
    });
    const pill = el('button', {
      className: 'chip',
      text: 'sampled',
      attrs: {
        // compact enough not to grow the section-head row: the panel below
        // must stay flush with its neighbor's top edge
        style: 'font-size:11px;line-height:1.3;padding:1px 9px;margin:-3px 0',
        title: 'this chart draws a sample — click for details',
      },
      on: {
        click: () => {
          const open = pop.style.display === 'block';
          pop.style.display = open ? 'none' : 'block';
        },
      },
    });
    document.addEventListener('mousedown', function onDown(ev) {
      if (!pill.isConnected) {
        document.removeEventListener('mousedown', onDown);
        return;
      }
      const target = ev.target as Node;
      if (!pill.contains(target) && !pop.contains(target)) pop.style.display = 'none';
    });
    sampleHost.append(pill, pop);
  }

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
