import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { apiClient } from "@/shared/api/client";
import type { ScatterQuery } from "@/shared/api/domains/observability";
import type { ScatterPoint } from "@/shared/api/domains/observability.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

/** Legacy XView poller cadence and point cap (internal/proxy/admin_ui.go). */
export const liveIntervalMs = 1_500;
export const maxLivePoints = 6_000;
const maxBackoffMs = 30_000;

export interface XViewFilters {
  window?: string;
  from?: string;
  to?: string;
  tz?: string;
  models?: string;
  endpoint?: string;
}

export interface XViewLiveState {
  points: ReadonlyArray<ScatterPoint>;
  truncated: boolean;
  initialPending: boolean;
  initialError: unknown;
  /** Last live poll failure; the last good points stay on screen. */
  liveError?: string;
  paused: boolean;
  lastUpdatedAt: number;
  refresh: () => void;
}

interface LiveDelta {
  /** `dataUpdatedAt` of the snapshot these points extend; stale deltas are dropped. */
  stamp: number;
  points: ReadonlyArray<ScatterPoint>;
  updatedAt: number;
  error?: string;
  paused: boolean;
}

const emptyDelta: LiveDelta = { stamp: 0, points: [], updatedAt: 0, paused: false };

function mergePoints(
  base: ReadonlyArray<ScatterPoint>,
  incoming: ReadonlyArray<ScatterPoint>,
): ScatterPoint[] {
  const byId = new Map<string, ScatterPoint>();
  for (const point of base) byId.set(point.request_id, point);
  for (const point of incoming) byId.set(point.request_id, point);
  const merged = [...byId.values()];
  merged.sort((left, right) => left.created_at.localeCompare(right.created_at));
  return merged.length > maxLivePoints ? merged.slice(merged.length - maxLivePoints) : merged;
}

/**
 * Loads the scatter snapshot, then keeps it current with the 1.5s delta feed.
 * Polling stops while the document is hidden and backs off exponentially on
 * failure, so a broken gateway cannot turn into a request storm.
 */
export function useXViewLive(filters: XViewFilters, live: boolean): XViewLiveState {
  const query = useMemo<ScatterQuery>(
    () => ({ ...filters, limit: maxLivePoints, include_summary: true, group_by: "model" }),
    [filters],
  );
  const [delta, setDelta] = useState<LiveDelta>(emptyDelta);
  const cursorRef = useRef({ ingested_at: "", request_id: "" });
  const stampRef = useRef(0);

  const snapshot = useQuery({
    queryKey: ["observability", "xview", "scatter", query],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.observability.xview.scatter, {
        query,
        signal,
        routeId: "observability.xview.scatter",
      }),
    staleTime: 5_000,
  });

  const snapshotData = snapshot.data;
  const stamp = snapshot.dataUpdatedAt;

  useEffect(() => {
    if (!live || !snapshotData) return undefined;
    // A fresh snapshot resets the delta cursor: the poller only fetches what the
    // snapshot has not already returned.
    cursorRef.current = snapshotData.cursor;
    stampRef.current = stamp;
    let cancelled = false;
    let timer = 0;
    let failures = 0;
    const controller = new AbortController();

    const schedule = (waitMs: number): void => {
      if (cancelled) return;
      timer = window.setTimeout(() => void tick(), waitMs);
    };

    const tick = async (): Promise<void> => {
      if (cancelled) return;
      if (typeof document !== "undefined" && document.hidden) {
        setDelta((current) =>
          current.paused && current.stamp === stampRef.current
            ? current
            : {
                ...(current.stamp === stampRef.current ? current : emptyDelta),
                stamp: stampRef.current,
                paused: true,
              },
        );
        schedule(liveIntervalMs);
        return;
      }
      const cursor = cursorRef.current;
      try {
        const response = await apiClient.request(endpoints.domains.observability.xview.delta, {
          query: {
            ...filters,
            limit: 200,
            ...(cursor.ingested_at && cursor.request_id
              ? { after_ingested_at: cursor.ingested_at, after_request_id: cursor.request_id }
              : {}),
          },
          signal: controller.signal,
          routeId: "observability.xview.delta",
        });
        if (cancelled) return;
        failures = 0;
        if (response.cursor.ingested_at && response.cursor.request_id) {
          cursorRef.current = response.cursor;
        }
        setDelta((current) => {
          const base = current.stamp === stampRef.current ? current.points : [];
          return {
            stamp: stampRef.current,
            points: response.points.length > 0 ? mergePoints(base, response.points) : base,
            updatedAt: response.points.length > 0 ? Date.now() : current.updatedAt,
            paused: false,
          };
        });
        schedule(response.has_more ? 0 : liveIntervalMs);
      } catch (cause) {
        if (cancelled) return;
        failures += 1;
        const message = safeAppErrorMessage(cause, "실시간 갱신에 실패했습니다.");
        setDelta((current) => ({
          ...(current.stamp === stampRef.current ? current : emptyDelta),
          stamp: stampRef.current,
          error: message,
          paused: false,
        }));
        schedule(Math.min(liveIntervalMs * 2 ** failures, maxBackoffMs));
      }
    };

    schedule(liveIntervalMs);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [filters, live, snapshotData, stamp]);

  const points = useMemo(
    () => mergePoints(snapshotData?.points ?? [], delta.stamp === stamp ? delta.points : []),
    [delta, snapshotData, stamp],
  );

  const refresh = useCallback(() => {
    setDelta(emptyDelta);
    void snapshot.refetch();
  }, [snapshot]);

  return {
    points,
    truncated: snapshotData?.truncated ?? false,
    initialPending: snapshot.isPending,
    initialError: snapshot.isError ? snapshot.error : undefined,
    liveError: delta.stamp === stamp ? delta.error : undefined,
    paused: live && delta.paused,
    lastUpdatedAt: Math.max(stamp, delta.stamp === stamp ? delta.updatedAt : 0),
    refresh,
  };
}
