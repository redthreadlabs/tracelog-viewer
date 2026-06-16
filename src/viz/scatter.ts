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
import { axisLeft } from 'd3-axis';
import { el, clear } from '../ui/dom';
import type { Rec } from '../data/types';
import { fmtScaleTime, fmtDuration, isUtcMode } from '../ui/format';
import { logTicks, contentWidth, axisLeftMargin } from './ticks';
import { drawTimeGrid, drawGhostBand, inGhost, GHOST_FOOTNOTE } from './timegrid';
import { placeTooltip } from './tooltip';
import type { SampleNote } from '../worker/backend';

const HEIGHT = 190;
const MARGIN = { top: 18, right: 10, bottom: 24, left: 56 };
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
  /** where the "sampled" pill renders — right-aligned above the chart */
  sampleHost?: HTMLElement,
  /** sampling already applied upstream (the worker boundary) */
  note?: SampleNote | null,
  /** time spans whose records aren't loaded (budget-refused, or still streaming
   *  in) — drawn as the ghost band */
  ghostSpans: [number, number][] = [],
  /** force the x-axis to span this full time range up-front (the selected
   *  window), so the axis is stable while records stream in and the not-yet-
   *  loaded regions read as ghost. Omitted → derived from the points. */
  domain?: [number, number],
): void {
  clear(container);
  if (sampleHost) clear(sampleHost);
  const points = instances.filter((r) => r.duration !== undefined && r.ts > 0);
  if (points.length === 0) return;

  const width = contentWidth(container, 280);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const styles = getComputedStyle(container); // resolve tokens in the panel scope
  const colorOf = (family: ResultFamily) =>
    styles.getPropertyValue(FAMILY_TOKEN[family]).trim();
  const lineColor = styles.getPropertyValue('--line-strong').trim();
  const inkFaint = styles.getPropertyValue('--ink-faint').trim();
  const axisFont = `10.5px ${styles.getPropertyValue('--font-data').trim()}`;

  let durMin = Infinity;
  let durMax = -Infinity;
  for (const r of points) {
    if (r.duration! < durMin) durMin = r.duration!;
    if (r.duration! > durMax) durMax = r.duration!;
  }
  const yMin = Math.max(durMin, 0.05);
  const yMax = durMax * 1.15;
  const y = scaleLog().domain([yMin, yMax]).range([innerH, 0]);

  // left margin sized to the widest y-axis (duration) label so it never clips,
  // whatever the rendered width (MARGIN.left is the floor)
  const left = Math.max(
    MARGIN.left,
    axisLeftMargin(logTicks(yMin, yMax).map((v) => fmtDuration(v)), axisFont),
  );
  const innerW = width - left - MARGIN.right;

  // extend the domain to cover any refused (ghost) spans so they're visible —
  // over budget, the loaded points are a recent sliver and the older, refused
  // range shows as the ghost band rather than silently vanishing
  let t0 = points[0].ts;
  let t1 = points[points.length - 1].ts;
  for (const [a, b] of ghostSpans) {
    if (a < t0) t0 = a;
    if (b > t1) t1 = b;
  }
  // an explicit domain (the selected window) wins — the axis spans it whole, so
  // it doesn't jump as points stream in and the unloaded remainder reads as ghost
  if (domain) {
    t0 = domain[0];
    t1 = domain[1];
  }
  if (t1 === t0) t1 = t0 + 1000;
  const x = (isUtcMode() ? scaleUtc() : scaleTime())
    .domain([new Date(t0), new Date(t1)])
    .range([0, innerW]);

  container.style.position = 'relative';
  const svg = select(container).append('svg').attr('width', width).attr('height', HEIGHT);
  const g = svg.append('g').attr('transform', `translate(${left},${MARGIN.top})`);

  // ghost band first (chart background) — refused (over-budget) time spans
  drawGhostBand(g, x as (d: Date) => number, ghostSpans, innerW, innerH, styles);
  // time axis: background gridlines + humane labels (SVG, behind the canvas points)
  drawTimeGrid(g, x as (d: Date) => number, [t0, t1], innerW, innerH, styles);

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
    `position:absolute;left:${padLeft + left}px;top:${padTop + MARGIN.top}px;` +
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
  const disclosure: SampleNote | null =
    note ?? (drawn < n ? { drawn, total: n, okStep } : null);
  if (disclosure && sampleHost) {
    sampleHost.style.position = 'relative';
    const pop = el('div', {
      className: 'chart-tooltip',
      text:
        `Drawing ${disclosure.drawn.toLocaleString('en-US')} of ` +
        `${disclosure.total.toLocaleString('en-US')} points: every ` +
        `${ordinal(disclosure.okStep)} successful instance, and every problem ` +
        `instance. Hover and click consider every drawn point.`,
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
    const mx = event.clientX - box.left;
    const hit = nearest(mx, event.clientY - box.top);
    canvas.style.cursor = hit === -1 ? 'default' : 'pointer';
    const ghosted = inGhost(ghostSpans, x.invert(mx).getTime());
    // a refused (ghost) region has no points — still surface the footnote there
    if (hit === -1 && !ghosted) {
      tooltip.style.display = 'none';
      return;
    }
    if (hit === -1) {
      tooltip.innerHTML = `<div class="t">${fmtScaleTime(x.invert(mx).getTime(), 1000)}</div>${GHOST_FOOTNOTE}`;
    } else {
      const rec = points[hit];
      tooltip.innerHTML =
        `<div class="t">${fmtScaleTime(rec.ts, 1000)}</div><span class="row">${rec.result ?? rec.outcome ?? ''}<span class="v">${fmtDuration(rec.duration!)}</span></span>` +
        (ghosted ? GHOST_FOOTNOTE : '');
    }
    tooltip.style.display = 'block';
    placeTooltip(tooltip, container, event);
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
