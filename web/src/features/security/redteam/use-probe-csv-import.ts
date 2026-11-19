import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { importProbePrompts } from "./redteam-csv";
import { redteamKeys, routeId } from "./use-redteam-data";
import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { formatNumber } from "@/shared/utils/format";

interface State {
  owner: FeatureReadOwner;
  pending: boolean;
  stage: "reading" | "uploading";
  error?: { message: string; requestId?: string };
}

/** One file selection owns validation, its single write and current-screen feedback. */
export function useProbeCsvImport(canWrite: boolean, reason: string, contextKey: string) {
  const access = useFeatureMutationAccess([routeId], canWrite, reason);
  const owner = useFeatureReadOwner(
    routeId,
    JSON.stringify(["probe-csv-import", contextKey, access.allowed]),
    ["admin:write", "security:read"],
  );
  const client = useQueryClient();
  const active = useRef<{ owner: FeatureReadOwner; controller: AbortController } | undefined>(undefined);
  const [state, setState] = useState<State>();
  useLayoutEffect(
    () => () => {
      if (active.current?.owner === owner) {
        active.current.controller.abort();
        active.current = undefined;
      }
    },
    [owner],
  );

  const run = async (file: File): Promise<void> => {
    if (active.current || !access.allowed || !owner.isCurrent()) return;
    const flight = { owner, controller: new AbortController() };
    active.current = flight;
    const owns = () => active.current === flight && owner.isCurrent() && !flight.controller.signal.aborted;
    const assertCurrent = () => {
      if (!owns()) throw new AppError("이전 CSV 가져오기입니다.", { kind: "aborted" });
      access.assertCurrent();
    };
    const context = { signal: flight.controller.signal, assertCurrent };
    let submitted = false;
    setState({ owner, pending: true, stage: "reading" });
    try {
      assertCurrent();
      const { readProbeCsvFile } = await import("./probe-csv-file");
      assertCurrent();
      const prepared = await readProbeCsvFile(file, context);
      assertCurrent();
      submitted = true;
      setState({ owner, pending: true, stage: "uploading" });
      const result = await importProbePrompts(prepared.text, context);
      assertCurrent();
      let refreshed = true;
      try {
        await client.invalidateQueries({ queryKey: redteamKeys.probePacks }, { throwOnError: true });
      } catch {
        refreshed = false;
      }
      assertCurrent();
      toast.success(
        `프롬프트 ${formatNumber(result.imported_cases)}건, 묶음 ${formatNumber(result.packs_touched)}건을 반영했습니다.`,
      );
      if (result.skipped.length > 0)
        toast.warning(`건너뛴 행 ${formatNumber(result.skipped.length)}건`, {
          description: "CSV의 필수 검사 키와 요청 프롬프트를 확인하세요.",
        });
      if (!refreshed) toast.warning("가져오기는 반영되었습니다. 목록을 다시 불러오세요.");
    } catch (cause) {
      if (owns() && !(isAppError(cause) && cause.kind === "aborted")) {
        const message =
          !submitted && isAppError(cause) && cause.code === "invalid_csv"
            ? cause.message
            : safeAppErrorMessage(
                cause,
                "가져오기 결과를 확인하지 못했습니다. 목록에서 반영 여부를 확인하세요.",
              );
        const requestId = isAppError(cause) ? cause.requestId : undefined;
        setState({
          owner,
          pending: false,
          stage: submitted ? "uploading" : "reading",
          error: { message, requestId },
        });
        toast.error(message, {
          description: requestId ? `요청 ID: ${requestId}` : undefined,
          duration: Number.POSITIVE_INFINITY,
        });
      }
    } finally {
      if (active.current === flight) {
        const current = owns();
        active.current = undefined;
        if (current)
          setState((previous) => (previous?.owner === owner ? { ...previous, pending: false } : previous));
      }
    }
  };
  return {
    run,
    available: access.allowed && owner.readable,
    pending: state?.owner === owner && state.pending,
    stage: state?.owner === owner ? state.stage : undefined,
    error: state?.owner === owner ? state.error : undefined,
  };
}
