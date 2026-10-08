import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { isAppError } from "@/shared/api/error";
import {
  catchUpIntervalMs,
  cursorIdentity,
  cursorTime,
  liveIntervalMs,
  maxCatchUpPages,
  mergeXViewPoints,
  reconcileIntervalMs,
  refreshIntervalMs,
  updateXViewClock,
  validXViewCursor,
  type XViewBuffer,
  type XViewCursor,
  type XViewFilters,
} from "./xview-live-state";

export function startXViewPoller({
  filters,
  initial,
  initialCursor,
  isCurrent,
  publish,
  deny,
}: {
  filters: XViewFilters;
  initial: XViewBuffer;
  initialCursor: XViewCursor;
  isCurrent: () => boolean;
  publish: (buffer: XViewBuffer) => void;
  deny: () => void;
}): () => void {
  let buffer = initial;
  let displayedPoints = initial.points;
  let cursor = initialCursor;
  let cancelled = false;
  let timer = 0;
  let pruneTimer = 0;
  let failures = 0;
  let catchingUp = false;
  let burst = 0;
  let lastReconcile = performance.now();
  let lastRefresh = lastReconcile;
  const seen = new Set<string>(validXViewCursor(cursor) ? [cursorIdentity(cursor)] : []);
  const controller = new AbortController();
  const current = () => !cancelled && !controller.signal.aborted && isCurrent();
  const emit = (paint = true) => {
    if (!current()) return;
    if (paint) displayedPoints = buffer.points;
    publish({ ...buffer, points: displayedPoints });
  };
  const prune = () => {
    if (!current()) return;
    const merged = mergeXViewPoints(buffer.points, [], filters, buffer.clock, performance.now());
    if (merged.points !== buffer.points) {
      buffer = { ...buffer, points: merged.points };
      emit();
    }
    pruneTimer = window.setTimeout(prune, reconcileIntervalMs);
  };
  const schedule = (wait: number) => {
    if (current()) timer = window.setTimeout(() => void tick(), wait);
  };
  const tick = async () => {
    if (!current()) return;
    if (document.hidden) {
      buffer = { ...buffer, status: "hidden" };
      emit();
      schedule(liveIntervalMs);
      return;
    }
    const now = performance.now();
    const refresh = !catchingUp && now - lastRefresh >= refreshIntervalMs;
    const reconcile = !catchingUp && !refresh && now - lastReconcile >= reconcileIntervalMs;
    try {
      const response = await apiClient.request(endpoints.domains.observability.xview.delta, {
        query: {
          ...filters,
          limit: 200,
          ...(validXViewCursor(cursor)
            ? { after_ingested_at: cursor.ingested_at, after_request_id: cursor.request_id }
            : {}),
          ...(refresh ? { refresh: true } : reconcile ? { reconcile: true } : {}),
        },
        signal: controller.signal,
        routeId: "observability.xview.delta",
      });
      if (!current()) return;
      failures = 0;
      const received = performance.now();
      if (refresh) lastRefresh = lastReconcile = received;
      else if (reconcile) lastReconcile = received;
      const clock = updateXViewClock(buffer.clock, response.server_time, received);
      const merged = mergeXViewPoints(buffer.points, response.points, filters, clock, received);
      const next = response.cursor;
      const valid = validXViewCursor(next);
      const changed = valid && cursorIdentity(next) !== cursorIdentity(cursor);
      const before = cursorTime(cursor);
      const after = cursorTime(next);
      const backwards = before !== undefined && after !== undefined && after < before;
      const repeated = changed && seen.has(cursorIdentity(next));
      const stalled =
        backwards ||
        repeated ||
        (response.has_more && (!valid || !changed)) ||
        (!valid && (next.ingested_at !== "" || next.request_id !== ""));
      if (valid && !backwards && !repeated) {
        cursor = next;
        seen.add(cursorIdentity(cursor));
        const first = seen.values().next().value;
        if (seen.size > 256 && first !== undefined) seen.delete(first);
      }
      catchingUp = response.has_more && changed && !stalled;
      burst = catchingUp ? burst + 1 : 0;
      buffer = {
        points: merged.points,
        truncated: buffer.truncated || merged.truncated,
        clock,
        lastUpdatedAt: Date.now(),
        status: stalled ? "stalled" : catchingUp ? "catching-up" : "live",
      };
      // Paint at a bounded burst boundary, not for every 25ms forward page.
      const endBurst = burst >= maxCatchUpPages;
      emit(!catchingUp || endBurst);
      if (endBurst) burst = 0;
      schedule(catchingUp && !endBurst ? catchUpIntervalMs : liveIntervalMs);
    } catch (cause) {
      if (!current()) return;
      if (
        isAppError(cause) &&
        (cause.status === 401 || cause.status === 403 || cause.kind === "permission")
      ) {
        deny();
        return;
      }
      failures += 1;
      buffer = {
        ...buffer,
        status: "retrying",
        error: safeAppErrorMessage(cause, "실시간 갱신에 실패했습니다."),
      };
      emit();
      schedule(Math.min(liveIntervalMs * 2 ** failures, 30_000));
    }
  };
  pruneTimer = window.setTimeout(prune, reconcileIntervalMs);
  schedule(liveIntervalMs);
  return () => {
    cancelled = true;
    controller.abort();
    window.clearTimeout(timer);
    window.clearTimeout(pruneTimer);
  };
}
