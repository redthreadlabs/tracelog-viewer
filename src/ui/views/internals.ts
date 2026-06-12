/**
 * The viewer-internals pages (#/internals/…) are about the app itself — the
 * record store, the viewer's own performance — never about the observed
 * service. This small tab strip heads each one and keeps them a visibly
 * separate family from the log views.
 */
import { el } from '../dom';
import { setView } from '../hashstate';

const TABS: { view: string; label: string }[] = [
  { view: '/internals/store', label: 'Store' },
  { view: '/internals/perf', label: 'Performance' },
];

export function internalsTabs(active: string): HTMLElement {
  const strip = el('div', { className: 'section-head', attrs: { style: 'margin-bottom:0' } }, [
    el('span', { className: 'label', text: 'Viewer internals' }),
  ]);
  for (const tab of TABS) {
    strip.append(
      el('button', {
        className: tab.view === active ? 'nav-link on' : 'nav-link',
        text: tab.label,
        on: { click: () => setView(tab.view) },
      }),
    );
  }
  return strip;
}
