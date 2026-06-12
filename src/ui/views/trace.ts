/**
 * Trace waterfall (SPEC §6.3): for one trace_id, the transaction bar with
 * child spans laid out on a time axis, colored by span type, gaps ("self
 * time") visually evident. Trace-correlated events and errors appear as
 * point markers. Clicking any row opens the raw-record drawer. Works for
 * server traces and client perf-timer traces alike.
 */
import { el, clear } from '../dom';
import { storeClient } from '../../data/storeclient';
import { spanTypeToken, type TraceModel } from '../../data/trace';
import type { Rec } from '../../data/types';
import { renderRecDrawer } from '../recdrawer';
import { fmtCount, fmtDateTime, fmtDuration, zoneLabel } from '../format';

const LABEL_GUTTER = 280; // px reserved for row labels
const DEPTH_INDENT = 14;

export function renderTraceView(container: HTMLElement, traceId: string): () => void {
  let selected: Rec | null = null;

  const head = el('div', { className: 'trace-head' });
  const body = el('div', { className: 'trace-body' });
  const drawer = el('div', { className: 'drawer' });
  container.append(head, body, drawer);

  let token = 0;
  async function render(): Promise<void> {
    const t = ++token;
    const model = await storeClient.request<TraceModel>('traceData', { traceId });
    if (t !== token || !container.isConnected) return;
    renderHead(model);
    renderWaterfall(model);
  }

  function renderHead(model: TraceModel): void {
    clear(head);
    head.append(
      el('button', {
        className: 'btn btn-quiet',
        text: '← back',
        on: { click: () => history.back() },
      }),
    );
    if (model.root) {
      head.append(
        el('h2', { className: 'trace-title', text: model.root.name }),
        el('span', {
          className: 'budget',
          text: [
            model.root.duration !== undefined ? fmtDuration(model.root.duration) : null,
            model.root.result,
            model.root.outcome && model.root.outcome !== model.root.result
              ? model.root.outcome
              : null,
            model.root.userId && `user ${model.root.userId}`,
          ]
            .filter(Boolean)
            .join(' · '),
        }),
      );
    } else {
      head.append(el('h2', { className: 'trace-title', text: 'Trace' }));
    }
    head.append(el('span', { className: 'masthead-spacer' }));
    head.append(
      el('span', {
        className: 'budget faint',
        text: model.t0 > 0 ? `${fmtDateTime(model.t0)} ${zoneLabel()} · trace ${traceId.slice(0, 8)}…` : '',
      }),
    );
  }

  function renderWaterfall(model: TraceModel): void {
    clear(body);

    if (model.rows.length === 0) {
      body.append(
        el('div', { className: 'empty' }, [
          el('div', { className: 'fleuron', text: '❧' }),
          el('h3', { text: 'No records for this trace' }),
          el('p', {
            text: 'The trace may lie outside the scanned range — widen the scan and try again.',
          }),
        ]),
      );
      return;
    }

    const total = Math.max(model.t1 - model.t0, 1);

    // axis: ticks at fifths, labeled as offsets from trace start
    const axis = el('div', { className: 'trace-axis' });
    axis.style.marginLeft = `${LABEL_GUTTER}px`;
    for (let i = 0; i <= 5; i++) {
      const tick = el('span', {
        className: 'tick num',
        text: `+${fmtDuration((total * i) / 5)}`,
      });
      tick.style.left = `${(i / 5) * 100}%`;
      axis.append(tick);
    }
    const sheet = el('div', { className: 'trace-sheet' });
    sheet.append(axis);

    const rowsHost = el('div', { className: 'trace-rows' });
    // gridlines aligned with the axis fifths
    const grid = el('div', { className: 'trace-grid' });
    grid.style.left = `${LABEL_GUTTER}px`;
    for (let i = 1; i <= 5; i++) {
      const line = el('span');
      line.style.left = `${(i / 5) * 100}%`;
      grid.append(line);
    }
    rowsHost.append(grid);

    for (const row of model.rows) {
      const isPoint = row.rec.kind === 'event' || row.rec.kind === 'error';
      const color = `var(${spanTypeToken(row.rec)})`;
      const leftPct = ((row.start - model.t0) / total) * 100;
      const widthPct = ((row.end - row.start) / total) * 100;

      const label = el('div', { className: 'trace-label' }, [
        el('span', {
          className: 'trace-label-text',
          text: row.rec.name,
          title: row.rec.name,
        }),
      ]);
      label.style.paddingLeft = `${10 + row.depth * DEPTH_INDENT}px`;

      const track = el('div', { className: 'trace-track' });
      if (isPoint) {
        const marker = el('span', {
          className: 'trace-point',
          title: `${row.rec.name} @ +${fmtDuration(row.start - model.t0)}`,
        });
        marker.style.left = `calc(${leftPct}% - 4px)`;
        marker.style.background = color;
        if (row.rec.kind === 'error' || row.rec.level === 'error') {
          marker.classList.add('alarm');
        }
        track.append(marker);
      } else {
        const bar = el('span', {
          className: 'trace-bar',
          title: `${row.rec.name} — ${fmtDuration(row.end - row.start)} @ +${fmtDuration(row.start - model.t0)}`,
        });
        bar.style.left = `${leftPct}%`;
        bar.style.width = `max(${widthPct}%, 2px)`;
        bar.style.background = color;
        track.append(bar);
        track.append(
          el('span', {
            className: 'trace-dur num',
            text: fmtDuration(row.end - row.start),
            attrs: {
              style: `left: min(calc(${leftPct}% + max(${widthPct}%, 2px) + 6px), calc(100% - 64px))`,
            },
          }),
        );
      }

      const rowEl = el('div', {
        className: selected?.id === row.rec.id ? 'trace-row selected' : 'trace-row',
      });
      rowEl.append(label, track);
      rowEl.addEventListener('click', () => {
        selected = row.rec;
        renderRecDrawer(drawer, selected, () => {
          selected = null;
          renderRecDrawer(drawer, null, () => {});
          render();
        });
        render();
      });
      rowsHost.append(rowEl);
    }

    sheet.append(rowsHost);

    sheet.append(
      el('div', { className: 'trace-foot' }, [
        el('span', {
          className: 'budget faint',
          text: `${fmtCount(model.rows.length)} rows · ${fmtDuration(total)} total`,
        }),
      ]),
    );
    body.append(sheet);
  }

  const onData = () => render();
  storeClient.addEventListener('data', onData);
  render();

  return () => {
    token++;
    storeClient.removeEventListener('data', onData);
  };
}
