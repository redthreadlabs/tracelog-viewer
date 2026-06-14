/**
 * Position a chart hover tooltip just to the LEFT of the pointer, clamped to
 * the host box. Shared by every chart so the floating panel behaves the same
 * everywhere. The tooltip must already be visible with its content set, so its
 * measured width (offsetWidth) is current.
 */
export function placeTooltip(tooltip: HTMLElement, container: HTMLElement, event: MouseEvent): void {
  const rect = container.getBoundingClientRect();
  const gap = 12;
  // the panel's right edge sits `gap` left of the pointer; clamp so it doesn't
  // run off the host's left edge
  const left = Math.max(event.clientX - rect.left - gap - tooltip.offsetWidth, 0);
  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${Math.max(event.clientY - rect.top - 10, 0)}px`;
}
