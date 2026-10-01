import { useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { apiClient } from "@/shared/api/client";
import type { Policy, PolicyBody } from "@/shared/api/domains/governance";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import type { PolicyEditorAccess } from "./policy-editor-access";
import { fingerprint } from "./policy-editor-security";
import { acknowledged } from "./policy-editor-state";

export const editorQueryKey = ["governance", "policies"] as const;
export interface PolicyReview {
  body: PolicyBody;
  prefixKey: string;
  approval: object;
}
export function usePolicyEditorOperation({
  baseline,
  access,
  dirty,
  close,
  isReview,
}: {
  baseline: Policy;
  access: PolicyEditorAccess;
  dirty: boolean;
  close: () => void;
  isReview: (review: PolicyReview) => boolean;
}) {
  const client = useQueryClient();
  const [saved, setSaved] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [error, setError] = useState<{ cause: unknown; sent: boolean }>();
  const [phase, setPhase] = useState<"idle" | "checking" | "saving" | "refreshing">("idle");
  const flight = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(false);
  const completed = useRef(false);
  const guard = useDraftGuard({ dirty: dirty && !saved, onDiscard: close });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current?.abort();
      flight.current = undefined;
    };
  }, []);
  const current = (controller: AbortController) => {
    access.assertRead();
    if (!mounted.current || controller.signal.aborted || flight.current !== controller)
      throw new AppError("이전 편집 요청입니다.", { kind: "aborted" });
  };
  const sourceCurrent = () => {
    const query = client.getQueryState(editorQueryKey);
    const data = client.getQueryData<{ policies?: Policy[] | null }>(editorQueryKey);
    const rows = data?.policies?.filter((row) => row.id === baseline.id);
    return (
      query?.status === "success" &&
      !query.isInvalidated &&
      query.fetchStatus === "idle" &&
      rows?.length === 1 &&
      fingerprint(rows[0]) === fingerprint(baseline)
    );
  };
  const get = (controller: AbortController) =>
    apiClient.request(endpoints.domains.governance.policies.list, {
      signal: controller.signal,
      routeId: "governance.policies",
    });
  const assertBaseline = (rows: Policy[] | null | undefined) => {
    const selected = rows?.filter((row) => row.id === baseline.id);
    if (
      selected?.length !== 1 ||
      selected[0]?.enabled !== false ||
      fingerprint(selected[0]) !== fingerprint(baseline)
    )
      throw new AppError(
        "원본 정책이 바뀌었거나 비활성 상태를 확인할 수 없습니다. 닫은 뒤 최신 목록에서 다시 편집하세요.",
        { kind: "http", status: 409, code: "editor_source_changed" },
      );
  };
  const save = (review: PolicyReview) => {
    if (!mounted.current || flight.current || completed.current || !isReview(review)) return;
    try {
      access.assertRead();
      access.write.assertCurrent();
      access.assertPrefixes(review.prefixKey);
      access.assertApproval(review.approval);
      if (!sourceCurrent())
        throw new AppError("현재 목록을 다시 조회한 뒤 원본을 확인하세요.", {
          kind: "http",
          status: 409,
          code: "editor_source_changed",
        });
    } catch (cause) {
      setError({ cause, sent: false });
      return;
    }
    const controller = new AbortController();
    flight.current = controller;
    setError(undefined);
    let sent = false;
    void guard
      .run(
        async () => {
          setPhase("checking");
          const latest = await get(controller);
          current(controller);
          access.write.assertCurrent();
          access.assertPrefixes(review.prefixKey);
          access.assertApproval(review.approval);
          if (!isReview(review))
            throw new AppError("검토 기준이 바뀌었습니다. 다시 검토하세요.", {
              kind: "http",
              status: 409,
              code: "editor_source_changed",
            });
          assertBaseline(latest.policies);
          if (!sourceCurrent())
            throw new AppError("현재 목록 상태가 바뀌었습니다. 다시 확인하세요.", {
              kind: "http",
              status: 409,
              code: "editor_source_changed",
            });
          // No await between current admission and the existing central API call.
          setPhase("saving");
          sent = true;
          const result = await apiClient.request(endpoints.domains.governance.policies.save, {
            body: review.body,
            signal: controller.signal,
            routeId: "governance.policies",
          });
          current(controller);
          if (!acknowledged(result.policy, review.body))
            throw new AppError("저장 응답을 확인할 수 없습니다.", { kind: "contract" });
          completed.current = true;
          setSaved(true);
          setPhase("refreshing");
          await client.invalidateQueries({ queryKey: editorQueryKey, refetchType: "none" });
          current(controller);
          try {
            const fresh = await get(controller);
            current(controller);
            client.setQueryData(editorQueryKey, fresh);
            setRefreshFailed(false);
          } catch (cause) {
            current(controller);
            setRefreshFailed(true);
            setError({ cause, sent: false });
          }
        },
        (cause) => {
          try {
            current(controller);
            setError({ cause, sent });
          } catch {
            /* Security disposal publishes nothing. */
          }
        },
        () => {},
      )
      .finally(() => {
        if (flight.current === controller) {
          flight.current = undefined;
          if (mounted.current) setPhase("idle");
        }
      });
  };
  const refresh = () => {
    if (!mounted.current || flight.current) return;
    try {
      access.assertRead();
    } catch {
      return;
    }
    const controller = new AbortController();
    flight.current = controller;
    setError(undefined);
    setPhase("refreshing");
    void guard
      .run(
        async () => {
          const fresh = await get(controller);
          current(controller);
          client.setQueryData(editorQueryKey, fresh);
          setRefreshFailed(false);
        },
        (cause) => {
          try {
            current(controller);
            setError({ cause, sent: false });
          } catch {
            /* Late read is not current evidence. */
          }
        },
        () => {},
      )
      .finally(() => {
        if (flight.current === controller) {
          flight.current = undefined;
          if (mounted.current) setPhase("idle");
        }
      });
  };
  return {
    saved,
    error,
    refreshFailed,
    phase,
    pending: guard.pending,
    save,
    refresh,
    sourceCurrent,
    close: guard.requestClose,
  };
}
