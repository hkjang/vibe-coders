import { useLayoutEffect, useRef, useState } from "react";
import { downloadMultiRunExport, type MultiRunExportFormat } from "./multi-run-export";
import { chatRouteId } from "./use-chat-console";
import type { CompareAccess } from "./use-compare-access";
import { useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { apiClient } from "@/shared/api/client";
import type { MultiRunDiff } from "@/shared/api/domains/gateway.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

/** The read pane can unmount on run change while its owning access hook survives. */
export function useRunRead(runId: string, access: CompareAccess) {
  const owner = useFeatureReadOwner(
    chatRouteId,
    JSON.stringify(["multi-run-read", runId, access.readAllowed]),
  );
  const [stateOwner, setStateOwner] = useState(owner);
  const [diff, setDiff] = useState<MultiRunDiff>();
  const [pending, setPending] = useState<"" | "diff" | "export">("");
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const flight = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current?.abort();
      flight.current = undefined;
    };
  }, [owner]);

  const run = async (kind: "diff" | "export", format: MultiRunExportFormat = "md") => {
    if (!mounted.current || !owner.isCurrent() || flight.current) return;
    const current = new AbortController();
    const owned = () =>
      mounted.current && owner.isCurrent() && access.isCurrent() && flight.current === current;
    const assertCurrent = () => {
      if (!owned()) throw new AppError("현재 실행 조회를 다시 확인하세요.", { kind: "aborted" });
      access.assertRead();
    };
    try {
      access.assertRead();
      flight.current = current;
      if (stateOwner !== owner) setDiff(undefined);
      setStateOwner(owner);
      setPending(kind);
      setError(undefined);
      assertCurrent();
      if (kind === "diff") {
        const result = await apiClient.request(
          withPathParams(endpoints.domains.gateway.chat.multiRunDiff, { id: runId }),
          { routeId: chatRouteId, signal: current.signal },
        );
        assertCurrent();
        setDiff(result);
      } else await downloadMultiRunExport(runId, format, { assertCurrent, signal: current.signal });
    } catch (cause) {
      if (owned())
        setError({
          message: safeAppErrorMessage(
            cause,
            kind === "diff" ? "답변을 비교하지 못했습니다." : "실행 결과를 내보내지 못했습니다.",
          ),
          requestId: isAppError(cause) ? cause.requestId : undefined,
        });
    } finally {
      if (owned()) {
        flight.current = undefined;
        setPending("");
      }
    }
  };
  return {
    diff: stateOwner === owner ? diff : undefined,
    pending: stateOwner === owner ? pending : "",
    error: stateOwner === owner ? error : undefined,
    run,
  };
}
