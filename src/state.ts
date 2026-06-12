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
  /**
   * "Show this user's surrounding events" (SPEC §6.4): consumed by the
   * events view, which filters to the user in a ±5 min window around ts.
   */
  userContext: null as { userId: string; ts: number } | null,
};

export function resetViewState(): void {
  viewState.timeWindow = null;
  viewState.pendingRecordsSearch = null;
  viewState.userContext = null;
}
