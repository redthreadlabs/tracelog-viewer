/**
 * Cross-view state. The brushed time window narrows every view fed by the
 * current scan; a pending search lets one view deep-link into another
 * (e.g. overview row → records filtered to that transaction name).
 */
export const viewState = {
  /** [t0, t1] epoch-ms, or null for the full scanned range */
  timeWindow: null as [number, number] | null,
  /**
   * Set by the scanbar when the selection exceeds the memory budget (it loaded
   * the newest files that fit). `estBytes` is the full selection's estimated
   * decompressed size — the store inspector reads this to show over-budget
   * context + a recommended limit. Managed explicitly by the scanbar, NOT
   * cleared by resetViewState (which runs mid-scan, inside executePlan).
   */
  overBudget: null as { estBytes: number } | null,
  /** consumed once by the records view on next render */
  pendingRecordsSearch: null as string | null,
  /**
   * "Show this user's surrounding events" (SPEC §6.4): consumed by the
   * events view, which filters to the user in a ±5 min window around ts.
   */
  userContext: null as { userId: string; ts: number } | null,
  /** consumed once by the events view: plain user filter, no window */
  pendingEventsUser: null as string | null,
};

export function resetViewState(): void {
  viewState.timeWindow = null;
  viewState.pendingRecordsSearch = null;
  viewState.userContext = null;
  viewState.pendingEventsUser = null;
}
