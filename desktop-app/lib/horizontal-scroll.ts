/** Normalize mouse, Shift-wheel and trackpad input for a horizontal strip; preserve pinch zoom. */
export function bindHorizontalWheel(element: HTMLElement) {
  const wheel = (event: WheelEvent) => {
    if (event.ctrlKey) return;
    const delta = Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    const maximum = element.scrollWidth - element.clientWidth;
    if (maximum <= 0) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
    const before = element.scrollLeft;
    element.scrollLeft = Math.max(0, Math.min(maximum, before + delta * unit));
    if (element.scrollLeft !== before) event.preventDefault();
  };
  // React wheel listeners are passive; cancellation requires a native non-passive listener.
  element.addEventListener('wheel', wheel, { passive: false });
  return () => element.removeEventListener('wheel', wheel);
}
