/**
 * Metrics view (SPEC §6.5): runtime small-multiples per host (event-loop
 * delay, heap, RSS, CPU) with deployment markers from service.version
 * changes, and span self-time breakdown as stacked bars.
 */
import { el, clear, pendingBlock } from '../dom';
import { storeClient } from '../../data/storeclient';
import { perf } from '../../data/perf';
import {
  type SeriesPoint,
  type BreakdownResult,
  type DeploymentMarker,
} from '../../data/metrics';
import { renderLine } from '../../viz/line';
import { renderStackbars } from '../../viz/stackbars';
import { spanTypeColorToken } from '../../data/trace';
import { chosenBucketMs, bucketLabel } from '../bucketpicker';
import { viewState } from '../../state';
import { fmtBytes, fmtDuration } from '../format';

interface SeriesSpec {
  key: string;
  label: string;
  fmt: (v: number) => string;
}

const SERIES: SeriesSpec[] = [
  { key: 'nodejs.eventloop.delay.avg.ms', label: 'event-loop delay', fmt: fmtDuration },
  { key: 'nodejs.memory.heap.used.bytes', label: 'heap used', fmt: fmtBytes },
  { key: 'system.process.memory.rss.bytes', label: 'process rss', fmt: fmtBytes },
  { key: 'system.process.cpu.total.norm.pct', label: 'cpu', fmt: fmtPct },
];

function fmtPct(v: number): string {
  return `${Math.round(v * 100)}%`;
}

export function renderMetricsView(container: HTMLElement): () => void {
  const body = el('div', { className: 'txn-detail-body' });
  container.append(body);
  body.append(pendingBlock(200));

  let token = 0;
  async function render(): Promise<void> {
    const t = ++token;
    const doneRender = perf.begin('render', '/metrics');
    const data = await storeClient.request<{
      series: Map<string, Map<string, SeriesPoint[]>>;
      breakdown: BreakdownResult;
      markers: DeploymentMarker[];
    }>('metricsData', {
      window: viewState.timeWindow,
      bucketMs: chosenBucketMs(),
      sampleNames: SERIES.map((spec) => spec.key),
    });
    if (t !== token || !container.isConnected) return;
    clear(body);

    const markers = data.markers;
    const allSeries = data.series;
    const hosts = new Set<string>();
    for (const byHost of allSeries.values()) {
      for (const host of byHost.keys()) hosts.add(host);
    }

    if (hosts.size === 0) {
      body.append(
        el('div', { className: 'empty' }, [
          el('div', { className: 'fleuron', text: '❧' }),
          el('h3', { text: 'No metricsets in the scanned data' }),
          el('p', {
            text: 'Scan a range that includes the server channel; runtime metrics land every 60 s.',
          }),
        ]),
      );
      return;
    }

    // shared x domain across the row, from the union of all series
    let t0 = Infinity;
    let t1 = -Infinity;
    for (const byHost of allSeries.values()) {
      for (const series of byHost.values()) {
        if (series.length === 0) continue;
        t0 = Math.min(t0, series[0].t);
        t1 = Math.max(t1, series[series.length - 1].t);
      }
    }
    const domain: [number, number] = viewState.timeWindow ?? [t0, t1 === t0 ? t0 + 60_000 : t1];

    if (markers.length > 0) {
      body.append(
        el('div', { className: 'section-head' }, [
          el('span', { className: 'label', text: 'Deployments' }),
          el('span', {
            className: 'budget',
            text: markers.map((m) => m.version).join(' · '),
          }),
        ]),
      );
    }

    for (const host of [...hosts].sort()) {
      body.append(
        el('div', { className: 'section-head' }, [
          el('span', { className: 'label', text: 'Host' }),
          el('span', { className: 'mono', text: host }),
        ]),
      );
      const row = el('div', { className: 'metrics-row' });
      for (const spec of SERIES) {
        const cell = el('div', { className: 'metrics-cell' });
        cell.append(el('div', { className: 'label', text: spec.label }));
        const host_series = allSeries.get(spec.key)?.get(host) ?? [];
        const chart = el('div', { className: 'chart-host metrics-chart' });
        cell.append(chart);
        row.append(cell);
        // render after attach so clientWidth is real
        requestAnimationFrame(() =>
          renderLine(chart, host_series, { fmt: spec.fmt, domain, markers }),
        );
      }
      body.append(row);
    }

    // breakdown self-time
    const breakdown = data.breakdown;
    if (breakdown.buckets.length > 0) {
      const legendItems = breakdown.types.slice(0, 8).map((key: string) =>
        el('span', { className: 'chip', attrs: { style: 'cursor:default' } }, [
          el('span', {
            className: 'dot',
            attrs: { style: `background: var(${spanTypeColorToken(key)})` },
          }),
          el('span', { text: key }),
        ]),
      );
      body.append(
        el('div', { className: 'section-head', attrs: { style: 'margin-top:14px' } }, [
          el('span', { className: 'label', text: 'Span self-time by type' }),
          ...legendItems,
          el('span', { className: 'masthead-spacer' }),
          el('span', {
            className: 'budget faint',
            text:
              chosenBucketMs() === null
                ? `bars: auto = ${bucketLabel(breakdown.bucketMs)}`
                : `bars: ${bucketLabel(breakdown.bucketMs)}`,
          }),
        ]),
      );
      const chart = el('div', { className: 'chart-host' });
      body.append(chart);
      requestAnimationFrame(() => renderStackbars(chart, breakdown));
    }
    doneRender();
  }

  const onData = () => void render();
  storeClient.addEventListener('data', onData);
  const onResize = () => void render();
  window.addEventListener('resize', onResize);
  void render();

  return () => {
    token++;
    storeClient.removeEventListener('data', onData);
    window.removeEventListener('resize', onResize);
  };
}
