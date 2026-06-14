/**
 * Stacked time-series bar chart (SPEC §7 design language): record volume
 * per bucket, stacked by kind in the fixed kind palette. Colors come from
 * CSS tokens at render time — never hard-coded. Brush horizontally to zoom
 * the time window; double-click to reset.
 */
import { select } from 'd3-selection';
import { scaleUtc, scaleTime, scaleLinear } from 'd3-scale';
import { axisLeft } from 'd3-axis';
import { brushX, type D3BrushEvent } from 'd3-brush';
import { el, clear } from '../ui/dom';
import { RECORD_KINDS, type RecordKind } from '../data/types';
import type { BucketResult } from '../data/aggregate';
import { fmtCount, fmtScaleTime, isUtcMode } from '../ui/format';
import { contentWidth } from './ticks';
import { drawTimeGrid, drawGhostBand, inGhost, GHOST_FOOTNOTE } from './timegrid';
import { placeTooltip } from './tooltip';

const HEIGHT = 170;
const MARGIN = { top: 18, right: 12, bottom: 22, left: 56 };

export interface TimebarsCallbacks {
  onWindow: (window: [number, number] | null) => void;
}

export function renderTimebars(
  container: HTMLElement,
  data: BucketResult,
  callbacks: TimebarsCallbacks,
  /** spans where the working set is unfulfilled — drawn as the ghost band */
  ghostSpans: [number, number][] = [],
): void {
  clear(container);
  if (data.buckets.length === 0) return;

  const width = contentWidth(container, 320);
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const styles = getComputedStyle(container); // resolve tokens in the panel scope
  const kindColor = (kind: RecordKind) => styles.getPropertyValue(`--kind-${kind}`).trim();
  const lineColor = styles.getPropertyValue('--line-strong').trim();
  const inkFaint = styles.getPropertyValue('--ink-faint').trim();

  const svg = select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', HEIGHT)
    .attr('viewBox', `0 0 ${width} ${HEIGHT}`);

  const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

  const x = (isUtcMode() ? scaleUtc() : scaleTime())
    .domain([new Date(data.domain[0]), new Date(data.domain[1])])
    .range([0, innerW]);

  const maxTotal = Math.max(1, ...data.buckets.map((b) => b.total));
  const y = scaleLinear().domain([0, maxTotal]).nice().range([innerH, 0]);

  // ghost band first (chart background) — where the working set is unfulfilled
  drawGhostBand(g, x as (d: Date) => number, ghostSpans, innerW, innerH, styles);
  // time axis: background gridlines + humane labels (drawn first, behind bars)
  drawTimeGrid(g, x as (d: Date) => number, data.domain, innerW, innerH, styles, data.bucketMs);

  g.append('g')
    .call(axisLeft(y).ticks(4).tickFormat((d) => fmtCount(d as number)).tickSizeOuter(0))
    .call((sel) => {
      sel.selectAll('text').attr('fill', inkFaint).style('font', '10.5px var(--font-data)');
      sel.selectAll('line').attr('stroke', lineColor);
      sel.select('.domain').attr('stroke', 'none');
    });

  // bars, stacked by kind in fixed order
  const barW = Math.max(1, (innerW / data.buckets.length) * 0.82);
  const barsG = g.append('g');
  for (const bucket of data.buckets) {
    if (bucket.total === 0) continue;
    const cx = x(new Date(bucket.t0 + data.bucketMs / 2));
    let yCursor = innerH;
    for (const kind of RECORD_KINDS) {
      const count = bucket.counts[kind] ?? 0;
      if (count === 0) continue;
      const h = innerH - y(count);
      yCursor -= h;
      barsG
        .append('rect')
        .attr('x', cx - barW / 2)
        .attr('y', yCursor)
        .attr('width', barW)
        .attr('height', Math.max(h, 0.5))
        .attr('fill', kindColor(kind))
        .attr('shape-rendering', 'crispEdges');
    }
  }

  // tooltip
  const tooltip = el('div', { className: 'chart-tooltip' });
  container.append(tooltip);

  svg
    .on('mousemove', (event: MouseEvent) => {
      const [mx] = pointerInG(event, container);
      const t = x.invert(mx).getTime();
      const idx = Math.floor((t - data.domain[0]) / data.bucketMs);
      const bucket = data.buckets[idx];
      const ghosted = inGhost(ghostSpans, t);
      // show over an empty ghost region too, so the footnote always appears there
      if ((!bucket || bucket.total === 0) && !ghosted) {
        tooltip.style.display = 'none';
        return;
      }
      const lines = bucket
        ? RECORD_KINDS.filter((k) => bucket.counts[k]).map(
            (k) =>
              `<span class="row"><span class="dot" style="background:${kindColor(k)}"></span>${k}<span class="v">${fmtCount(bucket.counts[k]!)}</span></span>`,
          )
        : [];
      const when = bucket ? bucket.t0 : t;
      tooltip.innerHTML = `<div class="t">${fmtScaleTime(when, data.bucketMs)}</div>${lines.join('')}${ghosted ? GHOST_FOOTNOTE : ''}`;
      tooltip.style.display = 'block';
      placeTooltip(tooltip, container, event);
    })
    .on('mouseleave', () => {
      tooltip.style.display = 'none';
    });

  // drag to set the time range
  const brush = brushX<unknown>()
    .extent([
      [0, 0],
      [innerW, innerH],
    ])
    .on('end', (event: D3BrushEvent<unknown>) => {
      if (!event.selection || !event.sourceEvent) return;
      const [x0, x1] = event.selection as [number, number];
      if (x1 - x0 < 4) return;
      callbacks.onWindow([x.invert(x0).getTime(), x.invert(x1).getTime()]);
    });

  g.append('g')
    .attr('class', 'brush')
    .call(brush)
    .select('.selection')
    .attr('fill', styles.getPropertyValue('--thread').trim())
    .attr('fill-opacity', 0.12)
    .attr('stroke', styles.getPropertyValue('--thread').trim());

  function pointerInG(event: MouseEvent, host: HTMLElement): [number, number] {
    const rect = host.getBoundingClientRect();
    // the SVG sits inside the host's padding, so the g origin is offset by it
    const padLeft = parseFloat(styles.paddingLeft) || 0;
    const padTop = parseFloat(styles.paddingTop) || 0;
    return [
      event.clientX - rect.left - padLeft - MARGIN.left,
      event.clientY - rect.top - padTop - MARGIN.top,
    ];
  }
}
