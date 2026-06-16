/**
 * Stacked time-series bars over a generalized SeriesResult (SPEC §11): each
 * bucket is split into an ordered set of series, bar height is the bucket total.
 * The consolidated successor to timebars/stackbars — color is supplied by a
 * strategy callback (the overview maps rank → --series-N; a breakdown could map
 * span types), and the y-axis value formatter is caller-supplied (durations,
 * counts, bytes). Brush horizontally to set the time range; the ghost band marks
 * spans the working set hasn't fulfilled.
 */
import { select } from 'd3-selection';
import { scaleUtc, scaleTime, scaleLinear } from 'd3-scale';
import { axisLeft } from 'd3-axis';
import { brushX, type D3BrushEvent } from 'd3-brush';
import { el, clear } from '../ui/dom';
import type { SeriesResult } from '../data/aggregate';
import { fmtScaleTime, isUtcMode, omitZero } from '../ui/format';
import { contentWidth, axisLeftMargin } from './ticks';
import { drawTimeGrid, drawGhostBand, inGhost, GHOST_FOOTNOTE } from './timegrid';
import { placeTooltip } from './tooltip';

const HEIGHT = 170;
const MARGIN = { top: 18, right: 12, bottom: 22, left: 56 };

export interface SeriesbarsOpts {
  /** color for a series key at its stack/legend index (styles = panel scope) */
  colorOf: (key: string, index: number, styles: CSSStyleDeclaration) => string;
  /** format a single value for the tooltip (e.g. fmtDuration) */
  formatValue: (n: number) => string;
  /** y-axis label formatter built from the whole tick set (consistent unit,
   *  minimal precision, zero omitted). Defaults to formatValue with the zero
   *  origin dropped. */
  axisFormat?: (ticks: number[]) => (n: number) => string;
  /** drag-to-set-range; null when the brush is cleared */
  onRange: (range: [number, number] | null) => void;
}

export function renderSeriesbars(
  container: HTMLElement,
  data: SeriesResult,
  opts: SeriesbarsOpts,
  /** spans where the working set is unfulfilled — drawn as the ghost band */
  ghostSpans: [number, number][] = [],
): void {
  clear(container);
  if (data.buckets.length === 0) return;

  const width = contentWidth(container, 320);
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const styles = getComputedStyle(container); // resolve tokens in the panel scope
  const colorOf = (key: string, i: number) => opts.colorOf(key, i, styles);
  const lineColor = styles.getPropertyValue('--line-strong').trim();
  const inkFaint = styles.getPropertyValue('--ink-faint').trim();
  const axisFont = `10.5px ${styles.getPropertyValue('--font-data').trim()}`;

  const maxTotal = Math.max(1, ...data.buckets.map((b) => b.total));
  const y = scaleLinear().domain([0, maxTotal]).nice().range([innerH, 0]);

  // y-axis labels from the whole tick set (consistent unit, minimal precision,
  // zero omitted), and a left margin sized to the widest of them so they never
  // clip off the chart's left edge at any width (MARGIN.left is the floor)
  const yTicks = y.ticks(4);
  const yLabel = opts.axisFormat ? opts.axisFormat(yTicks) : omitZero(opts.formatValue);
  const left = Math.max(MARGIN.left, axisLeftMargin(yTicks.map(yLabel), axisFont));
  const innerW = width - left - MARGIN.right;

  const svg = select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', HEIGHT)
    .attr('viewBox', `0 0 ${width} ${HEIGHT}`);

  const g = svg.append('g').attr('transform', `translate(${left},${MARGIN.top})`);

  const x = (isUtcMode() ? scaleUtc() : scaleTime())
    .domain([new Date(data.domain[0]), new Date(data.domain[1])])
    .range([0, innerW]);

  // ghost band first (chart background), then gridlines, then bars
  drawGhostBand(g, x as (d: Date) => number, ghostSpans, innerW, innerH, styles);
  drawTimeGrid(g, x as (d: Date) => number, data.domain, innerW, innerH, styles, data.bucketMs);

  g.append('g')
    .call(axisLeft(y).tickValues(yTicks).tickFormat((d) => yLabel(d as number)).tickSizeOuter(0))
    .call((sel) => {
      sel.selectAll('text').attr('fill', inkFaint).style('font', '10.5px var(--font-data)');
      sel.selectAll('line').attr('stroke', lineColor);
      sel.select('.domain').attr('stroke', 'none');
    });

  // bars, stacked in series order
  const barW = Math.max(1, (innerW / data.buckets.length) * 0.82);
  const barsG = g.append('g');
  const color = data.series.map((key, i) => colorOf(key, i));
  for (const bucket of data.buckets) {
    if (bucket.total === 0) continue;
    const cx = x(new Date(bucket.t0 + data.bucketMs / 2));
    let yCursor = innerH;
    for (let i = 0; i < data.series.length; i++) {
      const v = bucket.values[data.series[i]] ?? 0;
      if (v === 0) continue;
      const h = innerH - y(v);
      yCursor -= h;
      barsG
        .append('rect')
        .attr('x', cx - barW / 2)
        .attr('y', yCursor)
        .attr('width', barW)
        .attr('height', Math.max(h, 0.5))
        .attr('fill', color[i])
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
      if ((!bucket || bucket.total === 0) && !ghosted) {
        tooltip.style.display = 'none';
        return;
      }
      const rows = bucket
        ? data.series
            .filter((key) => (bucket.values[key] ?? 0) > 0)
            .map(
              (key, i) =>
                `<span class="row"><span class="dot" style="background:${colorOf(key, i)}"></span>${key}<span class="v">${opts.formatValue(bucket.values[key]!)}</span></span>`,
            )
        : [];
      const when = bucket ? bucket.t0 : t;
      tooltip.innerHTML = `<div class="t">${fmtScaleTime(when, data.bucketMs)}</div>${rows.join('')}${ghosted ? GHOST_FOOTNOTE : ''}`;
      tooltip.style.display = 'block';
      placeTooltip(tooltip, container, event);
    })
    .on('mouseleave', () => {
      tooltip.style.display = 'none';
    });

  // drag to set the time range
  const brush = brushX<unknown>()
    // -MARGIN.top lifts the brushable area from the plot top up to the very top
    // of the SVG (the group is translated down by MARGIN.top), so a drag can
    // start at the chart's top edge rather than below the headroom margin
    .extent([
      [0, -MARGIN.top],
      [innerW, innerH],
    ])
    .on('end', (event: D3BrushEvent<unknown>) => {
      if (!event.selection || !event.sourceEvent) return;
      const [x0, x1] = event.selection as [number, number];
      if (x1 - x0 < 4) return;
      opts.onRange([x.invert(x0).getTime(), x.invert(x1).getTime()]);
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
    const padLeft = parseFloat(styles.paddingLeft) || 0;
    const padTop = parseFloat(styles.paddingTop) || 0;
    return [
      event.clientX - rect.left - padLeft - left,
      event.clientY - rect.top - padTop - MARGIN.top,
    ];
  }
}
