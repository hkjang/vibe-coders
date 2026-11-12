/** Shared cancellation for optional table tools while their local assets load. */
export function cancelPendingTool(dismiss: () => void): () => void {
  // User intent cancels a pending open. A queued scroll event from bringing the
  // clicked row into view must not cancel its first menu request.
  const events = ["pointerdown", "keydown", "wheel", "touchmove", "resize"];
  for (const event of events) window.addEventListener(event, dismiss, true);
  return () => {
    for (const event of events) window.removeEventListener(event, dismiss, true);
  };
}
