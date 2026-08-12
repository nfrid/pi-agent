export function visualViewportKeyboardInset(
  layoutHeight: number,
  viewportHeight: number,
  viewportOffsetTop: number,
): number {
  return Math.max(0, layoutHeight - viewportHeight - viewportOffsetTop);
}
