import { captureAction } from "@/shared/telemetry/action-channel";
import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "@/shared/notifications/toast";
import { useAuth } from "@/app/auth/AuthProvider";
import type { PreparedProbeCsv } from "./probe-csv-file";
import type { ProbeCsvReview } from "@/shared/api/domains/redteam-probe-csv-review";
import { redteamKeys, routeId } from "./use-redteam-data";
import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { formatNumber } from "@/shared/utils/format";

interface State {
  selectionId: symbol;
  prepared: boolean;
  owner: FeatureReadOwner;
  filename: string;
  pending: boolean;
  stage: "reading" | "reviewing" | "applying";
  review?: ProbeCsvReview;
  error?: { message: string; requestId?: string };
}
interface Selection {
  id: symbol;
  owner: FeatureReadOwner;
  controller: AbortController;
  pending: boolean;
  prepared?: PreparedProbeCsv;
  review?: ProbeCsvReview;
}
function problem(cause: unknown, applying: boolean): string {
  if (isAppError(cause)) {
    if (cause.kind === "contract" && cause.code === "invalid_csv") return cause.message;
    if (cause.status === 409) return "파일·계정·저장 내용이 바뀌었습니다. 다시 검토하세요.";
    if (cause.status === 413) return "검토 한도를 초과했습니다. 파일을 나누어 다시 선택하세요.";
    if (cause.status === 404) return "서버가 CSV 변경 비교를 지원하지 않습니다. 서버 버전을 확인하세요.";
  }
  return safeAppErrorMessage(
    cause,
    applying
      ? "적용 여부가 불확실합니다. 현재 목록을 확인하고 다시 검토하세요."
      : "변경 비교에 실패했습니다. 연결·권한을 확인하고 다시 검토하세요.",
  );
}

/** One selection owns all read pages and a separately confirmed, single apply. */
export function useProbeCsvImport(canWrite: boolean, reason: string, contextKey: string) {
  const access = useFeatureMutationAccess([routeId], canWrite, reason);
  const auth = useAuth();
  const owner = useFeatureReadOwner(
    routeId,
    JSON.stringify(["probe-csv-import", contextKey, access.allowed, [...(auth.user?.scopes ?? [])].sort()]),
    ["admin:write", "security:read"],
  );
  const client = useQueryClient();
  const active = useRef<Selection | undefined>(undefined);
  const [state, setState] = useState<State>();
  const renderedSelection = state?.owner === owner ? state.selectionId : undefined;
  const renderedReview = state?.owner === owner ? state.review : undefined;
  useLayoutEffect(
    () => () => {
      const selection = active.current;
      if (selection?.owner === owner) {
        selection.controller.abort();
        selection.prepared = undefined;
        selection.review = undefined;
        active.current = undefined;
      }
      setState((previous) => (previous?.owner === owner ? undefined : previous));
    },
    [owner],
  );

  const owns = (selection: Selection) =>
    active.current === selection && selection.owner.isCurrent() && !selection.controller.signal.aborted;
  const context = (selection: Selection) => ({
    signal: selection.controller.signal,
    assertCurrent: () => {
      if (!owns(selection)) throw new AppError("이전 CSV 검토입니다.", { kind: "aborted" });
      access.assertCurrent();
    },
  });
  const update = (selection: Selection, changes: Partial<State>) => {
    if (owns(selection))
      setState((previous) => (previous?.owner === owner ? { ...previous, ...changes } : previous));
  };
  const close = () => {
    const selection = active.current;
    if (selection?.owner !== owner || selection.id !== renderedSelection) return;
    selection.controller.abort();
    selection.prepared = undefined;
    selection.review = undefined;
    active.current = undefined;
    setState(undefined);
  };
  const fail = (selection: Selection, cause: unknown, applying = false) => {
    if (!owns(selection) || (isAppError(cause) && cause.kind === "aborted")) return;
    selection.review = undefined;
    const error = {
      message: problem(cause, applying),
      requestId: isAppError(cause) ? cause.requestId : undefined,
    };
    update(selection, { review: undefined, error });
    toast.error(error.message, {
      description: error.requestId ? "요청 ID: " + error.requestId : undefined,
      duration: Number.POSITIVE_INFINITY,
    });
  };
  const finish = (selection: Selection) => {
    selection.pending = false;
    update(selection, { pending: false });
  };
  const readReview = async (selection: Selection, offset = 0, previous?: ProbeCsvReview) => {
    const guard = context(selection);
    guard.assertCurrent();
    if (!selection.prepared) return;
    const { reviewProbePrompts } = await import("./redteam-csv");
    guard.assertCurrent();
    const review = await reviewProbePrompts(selection.prepared.text, offset, previous?.revision, guard);
    guard.assertCurrent();
    if (
      review.offset !== offset ||
      (previous &&
        (review.revision !== previous.revision ||
          review.file_sha256 !== previous.file_sha256 ||
          review.total_items !== previous.total_items ||
          review.imported_cases !== previous.imported_cases ||
          review.packs_touched !== previous.packs_touched ||
          JSON.stringify(review.counts) !== JSON.stringify(previous.counts)))
    )
      throw new AppError("검토 페이지가 일치하지 않습니다.", { kind: "contract" });
    selection.review = review;
    update(selection, { review, error: undefined });
  };
  const run = async (file: File): Promise<void> => {
    if (active.current || !access.allowed || !owner.isCurrent()) return;
    const selection: Selection = {
      id: Symbol("csv-selection"),
      owner,
      controller: new AbortController(),
      pending: true,
    };
    active.current = selection;
    setState({
      selectionId: selection.id,
      prepared: false,
      owner,
      filename: file.name,
      pending: true,
      stage: "reading",
    });
    try {
      const guard = context(selection);
      guard.assertCurrent();
      const { readProbeCsvFile } = await import("./probe-csv-file");
      guard.assertCurrent();
      const prepared = await readProbeCsvFile(file, guard);
      guard.assertCurrent();
      if (prepared.rows > 10_000)
        throw new AppError("CSV를 10,000행 이하로 나누어 선택하세요.", {
          kind: "contract",
          code: "invalid_csv",
        });
      selection.prepared = prepared;
      update(selection, { stage: "reviewing", prepared: true });
      await readReview(selection);
    } catch (cause) {
      fail(selection, cause);
    } finally {
      finish(selection);
    }
  };
  const goTo = async (offset: number) => {
    const selection = active.current;
    if (
      !selection ||
      selection.id !== renderedSelection ||
      !owns(selection) ||
      selection.pending ||
      !selection.review ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset >= selection.review.total_items
    )
      return;
    const previous = selection.review;
    selection.pending = true;
    update(selection, { pending: true, stage: "reviewing", error: undefined });
    try {
      await readReview(selection, offset, previous);
    } catch (cause) {
      fail(selection, cause);
    } finally {
      finish(selection);
    }
  };
  const reviewAgain = async () => {
    const selection = active.current;
    if (!selection || !owns(selection) || selection.pending || !selection.prepared) return;
    selection.pending = true;
    selection.review = undefined;
    update(selection, { pending: true, stage: "reviewing", review: undefined, error: undefined });
    try {
      await readReview(selection);
    } catch (cause) {
      fail(selection, cause);
    } finally {
      finish(selection);
    }
  };
  const apply = async (revision: string) => {
    const selection = active.current;
    const review = selection?.review;
    if (
      !selection ||
      selection.id !== renderedSelection ||
      review !== renderedReview ||
      !review ||
      !selection.prepared ||
      !owns(selection) ||
      selection.pending ||
      review.revision !== revision
    )
      return;
    selection.pending = true;
    update(selection, { pending: true, stage: "applying", error: undefined });
    const observation = captureAction("import", undefined, () => owns(selection));
    try {
      const guard = context(selection);
      guard.assertCurrent();
      const { applyReviewedProbePrompts } = await import("./redteam-csv");
      guard.assertCurrent();
      const result = await applyReviewedProbePrompts(selection.prepared.text, revision, guard);
      guard.assertCurrent();
      if (
        !result.review_applied ||
        result.applied_revision !== revision ||
        result.imported_cases !== review.imported_cases ||
        result.packs_touched !== review.packs_touched
      )
        throw new AppError("적용 응답을 확인할 수 없습니다.", { kind: "contract" });
      observation?.success();
      let refreshed = true;
      try {
        await client.invalidateQueries({ queryKey: redteamKeys.probePacks }, { throwOnError: true });
      } catch {
        refreshed = false;
      }
      guard.assertCurrent();
      toast.success(
        "프롬프트 " +
          formatNumber(result.imported_cases) +
          "건, 묶음 " +
          formatNumber(result.packs_touched) +
          "건을 반영했습니다.",
      );
      if (result.skipped.length > 0)
        toast.warning("건너뛴 행 " + formatNumber(result.skipped.length) + "건", {
          description: "CSV의 필수 검사 키와 요청 프롬프트를 확인하세요.",
        });
      if (!refreshed) toast.warning("가져오기는 반영되었습니다. 목록을 다시 불러오세요.");
      close();
    } catch (cause) {
      observation?.failure(cause);
      fail(selection, cause, true);
    } finally {
      finish(selection);
    }
  };
  const current = state?.owner === owner ? state : undefined;
  return {
    run,
    close,
    goTo,
    reviewAgain,
    apply,
    available: access.allowed && owner.readable,
    open: Boolean(current),
    pending: current?.pending ?? false,
    stage: current?.stage,
    filename: current?.filename ?? "",
    review: current?.review,
    error: current?.error,
    canReviewAgain: Boolean(current?.prepared && !current.pending),
  };
}
export type ProbeCsvImportOperation = ReturnType<typeof useProbeCsvImport>;
