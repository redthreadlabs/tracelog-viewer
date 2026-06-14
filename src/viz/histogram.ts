/**
 * Duration histogram (log-spaced bins) for the transaction drill-down.
 * Colors from CSS tokens; shared tick formatting via fmtDuration.
 */
import { select } from 'd3-selection';
import { scaleLinear, scaleLog } from 'd3-scale';
import { axisBottom, axisLeft } from 'd3-axis';
import { el, clear } from '../ui/dom';
import type { HistBucket } from '../data/aggregate';
import { fmtCount, fmtDuration } from '../ui/format';
import { logTicks, contentWidth } from './ticks';
import { drawGhostFill } from './timegrid';

const HEIGHT = 190;
const MARGIN = { top: 8, right: 10, bottom: 24, left: 44 };

export function renderHistogram(
  container: HTMLElement,
  buckets: HistBucket[],
  /** non-empty when the instance set is partial (over budget): the whole
   *  distribution is unfulfilled, so wash the entire panel with the ghost hatch */
  ghostSpans: [number, number][] = [],
): void {
  clear(container);
  const nonEmpty = buckets.filter((b) => b.count > 0);
  if (nonEmpty.length === 0) return;

  const width = contentWidth(container, 280);
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const styles = getComputedStyle(container); // resolve tokens in the panel scope
  const barColor = styles.getPropertyValue('--kind-transaction').trim();
  const lineColor = styles.getPropertyValue('--line-strong').trim();
  const inkFaint = styles.getPropertyValue('--ink-faint').trim();

  // domain trimmed to occupied bins (log scale)
  const x0 = nonEmpty[0].x0;
  const x1 = nonEmpty[nonEmpty.length - 1].x1;
  const x = scaleLog().domain([x0, x1]).range([0, innerW]);
  const maxCount = Math.max(...buckets.map((b) => b.count));
  const y = scaleLinear().domain([0, maxCount]).nice().range([innerH, 0]);

  const svg = select(container)
    .append('svg')
    .attr('width', width)
    .attr('height', HEIGHT);
  const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

  // partial (over-budget) instance set → wash the whole panel with the ghost
  // hatch: this distribution is built on data the budget refused (SPEC §7)
  if (ghostSpans.length > 0) drawGhostFill(g, innerW, innerH, styles);

  g.append('g')
    .attr('transform', `translate(0,${innerH})`)
    .call(
      axisBottom(x)
        .tickValues(logTicks(x0, x1, 6))
        .tickFormat((d) => fmtDuration(d as number))
        .tickSizeOuter(0),
    )
    .call((sel) => {
      sel.selectAll('text').attr('fill', inkFaint).style('font', '10.5px var(--font-data)');
      sel.selectAll('line').attr('stroke', lineColor);
      sel.select('.domain').attr('stroke', lineColor);
    });

  g.append('g')
    .call(axisLeft(y).ticks(4).tickFormat((d) => fmtCount(d as number)).tickSizeOuter(0))
    .call((sel) => {
      sel.selectAll('text').attr('fill', inkFaint).style('font', '10.5px var(--font-data)');
      sel.selectAll('line').attr('stroke', lineColor);
      sel.select('.domain').attr('stroke', 'none');
    });

  const tooltip = el('div', { className: 'chart-tooltip' });
  container.append(tooltip);

  for (const bucket of buckets) {
    if (bucket.count === 0 || bucket.x1 < x0) continue;
    const bx0 = x(Math.max(bucket.x0, x0));
    const bx1 = x(bucket.x1);
    g.append('rect')
      .attr('x', bx0 + 0.5)
      .attr('y', y(bucket.count))
      .attr('width', Math.max(bx1 - bx0 - 1, 1))
      .attr('height', innerH - y(bucket.count))
      .attr('fill', barColor)
      .attr('fill-opacity', 0.8)
      .attr('shape-rendering', 'crispEdges')
      .on('mousemove', (event: MouseEvent) => {
        tooltip.innerHTML = `<div class="t">${fmtDuration(bucket.x0)} – ${fmtDuration(bucket.x1)}</div><span class="row">requests<span class="v">${fmtCount(bucket.count)}</span></span>`;
        tooltip.style.display = 'block';
        const rect = container.getBoundingClientRect();
        tooltip.style.left = `${Math.min(event.clientX - rect.left + 12, width - 170)}px`;
        tooltip.style.top = `${event.clientY - rect.top - 8}px`;
      })
      .on('mouseleave', () => {
        tooltip.style.display = 'none';
      });
  }
}
