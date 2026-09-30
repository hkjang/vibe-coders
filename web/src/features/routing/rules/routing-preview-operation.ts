import { useLayoutEffect, useRef, useState } from "react";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import type { RoutingPreviewAccess } from "./routing-preview-access";
import { previewSnapshot, type PreviewDraft, type PreviewState } from "./routing-preview-state";

export function useRoutingPreviewOperation(access: RoutingPreviewAccess) {
  const [state, setState] = useState<PreviewState>({ kind: "idle" });
  const mounted = useRef(false);
  const flight = useRef<AbortController | null>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current?.abort();
      flight.current = null;
    };
  }, []);
  async function run(readDraft: () => PreviewDraft): Promise<void> {
    if (!mounted.current || flight.current) return;
    try {
      access.assertRead();
    } catch {
      return;
    }
    const snapshot = previewSnapshot(readDraft(), access.currentPrefixes());
    if (!snapshot) return;
    const current = new AbortController();
    flight.current = current;
    const isCurrent = () => {
      if (!mounted.current || flight.current !== current || current.signal.aborted) return false;
      try {
        access.assertOwned();
        return true;
      } catch {
        return false;
      }
    };
    const canReceive = () => {
      if (!isCurrent()) return false;
      try {
        access.assertRead();
        return true;
      } catch {
        return false;
      }
    };
    setState({ kind: "pending", snapshot });
    try {
      access.assertRead();
      const result = await apiClient.request(endpoints.domains.routing.preview, {
        body: snapshot.body,
        signal: current.signal,
        routeId: "routing.rules",
      });
      if (canReceive()) setState({ kind: "success", snapshot, result });
    } catch (cause) {
      if (canReceive())
        setState({
          kind: "error",
          snapshot,
          message: safeAppErrorMessage(cause, "라우팅 미리보기를 실행하지 못했습니다."),
          requestId: isAppError(cause) ? cause.requestId : undefined,
        });
    } finally {
      if (flight.current === current) {
        const owned = isCurrent();
        flight.current = null;
        if (owned)
          setState((previous) =>
            previous.kind === "pending" && previous.snapshot === snapshot ? { kind: "idle" } : previous,
          );
      }
    }
  }
  return { state, run };
}
