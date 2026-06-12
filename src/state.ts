/**
 * Cross-view state. The brushed time window narrows every view fed by the
 * current scan; a pending search lets one view deep-link into another
 * (e.g. overview row → records filtered to that transaction name).
 */
export const viewState = {
  /** [t0, t1] epoch-ms, or null for the full scanned range */
  timeWindow: null as [number, number] | null,
  /** consumed once by the records view on next render */
  pendingRecordsSearch: null as string | null,
};

export function resetViewState(): void {
  viewState.timeWindow = null;
  viewState.pendingRecordsSearch = null;
}
