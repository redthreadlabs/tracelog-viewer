/**
 * Position a chart hover tooltip just to the LEFT of the pointer, clamped to
 * the host box. Shared by every chart so the floating panel behaves the same
 * everywhere. The tooltip must already be visible with its content set, so its
 * measured width (offsetWidth) is current.
 */
export function placeTooltip(tooltip: HTMLElement, container: HTMLElement, event: MouseEvent): void {
  const rect = container.getBoundingClientRect();
  const gap = 12;
  const cx = event.clientX - rect.left;
  // sit the panel's right edge `gap` left of the pointer; if that would run off
  // the host's left edge, flip to `gap` right of the pointer instead
  let left = cx - gap - tooltip.offsetWidth;
  if (left < 0) left = cx + gap;
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(event.clientY - rect.top - 10, 0)}px`;
}
