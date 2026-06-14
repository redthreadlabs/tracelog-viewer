/**
 * Small-multiple line chart for runtime metrics (SPEC §6.5), with optional
 * deployment markers (vertical thread-colored rules + version labels).
 */
import { select } from 'd3-selection';
import { scaleUtc, scaleTime, scaleLinear } from 'd3-scale';
import { axisLeft } from 'd3-axis';
import { el, clear } from '../ui/dom';
import type { SeriesPoint, DeploymentMarker } from '../data/metrics';
import { fmtDateTime, isUtcMode } from '../ui/format';
import { contentWidth } from './ticks';
import { drawTimeGrid } from './timegrid';

const HEIGHT = 110;
const MARGIN = { top: 14, right: 8, bottom: 18, left: 52 };

export interface LineOptions {
  /** value formatter for ticks + tooltip */
  fmt: (v: number) => string;
  /** shared x domain so every chart in the row aligns */
  domain: [number, number];
  markers?: DeploymentMarker[];
}

export function renderLine(
  container: HTMLElement,
  points: SeriesPoint[],
  options: LineOptions,
): void {
  clear(container);
  if (points.length === 0) return;

  const width = contentWidth(container, 200);
  const innerW = width - MARGIN.left - MARGIN.right;
  const innerH = HEIGHT - MARGIN.top - MARGIN.bottom;

  const styles = getComputedStyle(container); // resolve tokens in the panel scope
  const lineColor = styles.getPropertyValue('--kind-metricset').trim();
  const gridColor = styles.getPropertyValue('--line-strong').trim();
  const inkFaint = styles.getPropertyValue('--ink-faint').trim();
  const threadColor = styles.getPropertyValue('--thread').trim();

  const x = (isUtcMode() ? scaleUtc() : scaleTime())
    .domain([new Date(options.domain[0]), new Date(options.domain[1])])
    .range([0, innerW]);
  let vMax = -Infinity; // no spread: long ranges produce >100k points
  for (const p of points) if (p.v > vMax) vMax = p.v;
  const y = scaleLinear().domain([0, vMax * 1.1 || 1]).nice().range([innerH, 0]);

  const svg = select(container).append('svg').attr('width', width).attr('height', HEIGHT);
  const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

  // time axis: background gridlines + humane labels (drawn first, behind the line)
  drawTimeGrid(g, x as (d: Date) => number, options.domain, innerW, innerH, styles);

  g.append('g')
    .call(
      axisLeft(y)
        .ticks(3)
        .tickFormat((d) => options.fmt(d as number))
        .tickSizeOuter(0),
    )
    .call((sel) => {
      sel.selectAll('text').attr('fill', inkFaint).style('font', '10px var(--font-data)');
      sel.selectAll('line').attr('stroke', gridColor);
      sel.select('.domain').attr('stroke', 'none');
    });

  // the line itself — manual path, no d3-shape dependency
  let d = '';
  for (let i = 0; i < points.length; i++) {
    const px = x(new Date(points[i].t)).toFixed(1);
    const py = y(points[i].v).toFixed(1);
    d += `${i === 0 ? 'M' : 'L'}${px},${py}`;
  }
  g.append('path')
    .attr('d', d)
    .attr('fill', 'none')
    .attr('stroke', lineColor)
    .attr('stroke-width', 1.5)
    .attr('stroke-linejoin', 'round');

  // deployment markers
  for (const marker of options.markers ?? []) {
    if (marker.t < options.domain[0] || marker.t > options.domain[1]) continue;
    const mx = x(new Date(marker.t));
    g.append('line')
      .attr('x1', mx)
      .attr('x2', mx)
      .attr('y1', -10)
      .attr('y2', innerH)
      .attr('stroke', threadColor)
      .attr('stroke-dasharray', '3,3')
      .attr('stroke-width', 1);
    g.append('text')
      .attr('x', mx + 3)
      .attr('y', -3)
      .attr('fill', threadColor)
      .style('font', '9.5px var(--font-data)')
      .text(marker.version);
  }

  // hover: nearest point
  const tooltip = el('div', { className: 'chart-tooltip' });
  container.append(tooltip);
  svg
    .on('mousemove', (event: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      const mx = event.clientX - rect.left - MARGIN.left;
      const t = x.invert(mx).getTime();
      let best = points[0];
      for (const p of points) {
        if (Math.abs(p.t - t) < Math.abs(best.t - t)) best = p;
      }
      tooltip.innerHTML = `<div class="t">${fmtDateTime(best.t)}</div><span class="row">value<span class="v">${options.fmt(best.v)}</span></span>`;
      tooltip.style.display = 'block';
      tooltip.style.left = `${Math.min(event.clientX - rect.left + 12, width - 170)}px`;
      tooltip.style.top = `${event.clientY - rect.top - 8}px`;
    })
    .on('mouseleave', () => {
      tooltip.style.display = 'none';
    });
}
