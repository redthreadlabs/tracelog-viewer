/**
 * Stacked bars over time for the breakdown view (span self-time by type,
 * SPEC §6.5) — same visual grammar as the overview's volume chart, colored
 * by the fixed span-type palette.
 */
import { select } from 'd3-selection';
import { scaleUtc, scaleTime, scaleLinear } from 'd3-scale';
import { axisLeft } from 'd3-axis';
import { el, clear } from '../ui/dom';
import type { BreakdownResult } from '../data/metrics';
import { spanTypeColorToken } from '../data/trace';
import { fmtDateTime, fmtDuration, isUtcMode } from '../ui/format';
import { contentWidth } from './ticks';
import { drawTimeGrid } from './timegrid';

const HEIGHT = 180;
const MARGIN = { top: 18, right: 12, bottom: 22, left: 56 };

export function renderStackbars(container: HTMLElement, data: BreakdownResult): void {
  clear(container);
  if (data.buckets.length === 0) return;

  const width = contentWidth(container, 320);
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const styles = getComputedStyle(container); // resolve tokens in the panel scope
  const colorOf = (key: string) =>
    styles.getPropertyValue(spanTypeColorToken(key)).trim();
  const gridColor = styles.getPropertyValue('--line-strong').trim();
  const inkFaint = styles.getPropertyValue('--ink-faint').trim();

  const t0 = data.buckets[0].t0;
  const t1 = data.buckets[data.buckets.length - 1].t0 + data.bucketMs;
  const x = (isUtcMode() ? scaleUtc() : scaleTime())
    .domain([new Date(t0), new Date(t1)])
    .range([0, innerW]);

  const maxTotal = Math.max(
    1,
    ...data.buckets.map((b) => [...b.byType.values()].reduce((s, v) => s + v, 0)),
  );
  const y = scaleLinear().domain([0, maxTotal]).nice().range([innerH, 0]);

  const svg = select(container).append('svg').attr('width', width).attr('height', HEIGHT);
  const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

  // time axis: background gridlines + humane labels (drawn first, behind bars)
  drawTimeGrid(g, x as (d: Date) => number, [t0, t1], innerW, innerH, styles, data.bucketMs);

  g.append('g')
    .call(
      axisLeft(y)
        .ticks(4)
        .tickFormat((d) => fmtDuration(d as number))
        .tickSizeOuter(0),
    )
    .call((sel) => {
      sel.selectAll('text').attr('fill', inkFaint).style('font', '10.5px var(--font-data)');
      sel.selectAll('line').attr('stroke', gridColor);
      sel.select('.domain').attr('stroke', 'none');
    });

  const barW = Math.max(1, (innerW / data.buckets.length) * 0.82);
  for (const bucket of data.buckets) {
    const cx = x(new Date(bucket.t0 + data.bucketMs / 2));
    let yCursor = innerH;
    for (const key of data.types) {
      const value = bucket.byType.get(key) ?? 0;
      if (value <= 0) continue;
      const h = innerH - y(value);
      yCursor -= h;
      g.append('rect')
        .attr('x', cx - barW / 2)
        .attr('y', yCursor)
        .attr('width', barW)
        .attr('height', Math.max(h, 0.5))
        .attr('fill', colorOf(key))
        .attr('shape-rendering', 'crispEdges');
    }
  }

  // tooltip
  const tooltip = el('div', { className: 'chart-tooltip' });
  container.append(tooltip);
  svg
    .on('mousemove', (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const mx = event.clientX - rect.left - MARGIN.left;
      const t = x.invert(mx).getTime();
      const idx = Math.floor((t - data.buckets[0].t0) / data.bucketMs);
      const bucket = data.buckets[idx];
      if (!bucket || bucket.byType.size === 0) {
        tooltip.style.display = 'none';
        return;
      }
      const rows = data.types
        .filter((key) => (bucket.byType.get(key) ?? 0) > 0)
        .map(
          (key) =>
            `<span class="row"><span class="dot" style="background:${colorOf(key)}"></span>${key}<span class="v">${fmtDuration(bucket.byType.get(key)!)}</span></span>`,
        );
      tooltip.innerHTML = `<div class="t">${fmtDateTime(bucket.t0)}</div>${rows.join('')}`;
      tooltip.style.display = 'block';
      tooltip.style.left = `${Math.min(event.clientX - rect.left + 14, width - 190)}px`;
      tooltip.style.top = `${Math.max(event.clientY - rect.top - 10, 0)}px`;
    })
    .on('mouseleave', () => {
      tooltip.style.display = 'none';
    });
}
