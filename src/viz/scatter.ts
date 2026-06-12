/**
 * Duration-over-time scatter for the transaction drill-down. Each point is
 * one instance; color encodes the result family (ok / client-error /
 * failure). Clicking a point opens its trace waterfall.
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

export type ResultFamily = 'ok' | 'warn' | 'bad' | 'other';

export function resultFamily(rec: Rec): ResultFamily {
  const result = (rec.result ?? '').toLowerCase();
  const outcome = (rec.outcome ?? '').toLowerCase();
  if (result.startsWith('http 4')) return 'warn';
  if (result.startsWith('http 5') || result === 'error' || result === 'failure') return 'bad';
  if (outcome === 'failure') return 'bad';
  if (result.startsWith('http 2') || result.startsWith('http 3') || result === 'success') {
    return 'ok';
  }
  if (outcome === 'success') return 'ok';
  return 'other';
}

const FAMILY_TOKEN: Record<ResultFamily, string> = {
  ok: '--kind-span',
  warn: '--level-warn',
  bad: '--thread',
  other: '--ink-faint',
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

  const styles = getComputedStyle(document.documentElement);
  const colorOf = (family: ResultFamily) =>
    styles.getPropertyValue(FAMILY_TOKEN[family]).trim();
  const lineColor = styles.getPropertyValue('--line-strong').trim();
  const inkFaint = styles.getPropertyValue('--ink-faint').trim();

  const t0 = points[0].ts;
  const t1 = points[points.length - 1].ts;
  const x = (isUtcMode() ? scaleUtc() : scaleTime())
    .domain([new Date(t0), new Date(t1 === t0 ? t0 + 1000 : t1)])
    .range([0, innerW]);

  const durations = points.map((r) => r.duration!);
  const yMin = Math.max(Math.min(...durations), 0.05);
  const yMax = Math.max(...durations) * 1.15;
  const y = scaleLog().domain([yMin, yMax]).range([innerH, 0]);

  const svg = select(container).append('svg').attr('width', width).attr('height', HEIGHT);
  const g = svg.append('g').attr('transform', `translate(${MARGIN.left},${MARGIN.top})`);

  g.append('g')
    .attr('transform', `translate(0,${innerH})`)
    .call(
      axisBottom(x)
        .ticks(Math.min(7, Math.floor(innerW / 110)))
        .tickFormat((d) => timeTickFormat(t1 - t0)(d as Date))
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
        .tickValues(logTicks(yMin, yMax, 5))
        .tickFormat((d) => fmtDuration(d as number))
        .tickSizeOuter(0),
    )
    .call((sel) => {
      sel.selectAll('text').attr('fill', inkFaint).style('font', '10.5px var(--font-data)');
      sel.selectAll('line').attr('stroke', lineColor);
      sel.select('.domain').attr('stroke', 'none');
    });

  const tooltip = el('div', { className: 'chart-tooltip' });
  container.append(tooltip);

  for (const rec of points) {
    const family = resultFamily(rec);
    g.append('circle')
      .attr('cx', x(new Date(rec.ts)))
      .attr('cy', y(Math.max(rec.duration!, yMin)))
      .attr('r', 3)
      .attr('fill', colorOf(family))
      .attr('fill-opacity', family === 'ok' ? 0.55 : 0.9)
      .style('cursor', 'pointer')
      .on('mousemove', (event: MouseEvent) => {
        tooltip.innerHTML = `<div class="t">${fmtDateTime(rec.ts)}</div><span class="row">${rec.result ?? rec.outcome ?? ''}<span class="v">${fmtDuration(rec.duration!)}</span></span>`;
        tooltip.style.display = 'block';
        const rect = container.getBoundingClientRect();
        tooltip.style.left = `${Math.min(event.clientX - rect.left + 12, width - 190)}px`;
        tooltip.style.top = `${event.clientY - rect.top - 8}px`;
      })
      .on('mouseleave', () => {
        tooltip.style.display = 'none';
      })
      .on('click', () => onPick(rec));
  }
}
