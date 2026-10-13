import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { apiClient } from "@/shared/api/client";
import type { AlertRule, AlertRuleBody, AlertRuleUpdateBody } from "@/shared/api/domains/governance";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { catalogRecordCurrent } from "./policy-catalog-key";
import { usePolicyEditorAccess } from "./policy-editor-access";
import { usePolicyWriteGuard } from "./use-policy-write-guard";

const routeId = "governance.policies";
type Review = "edit" | "delete";

export function useAlertRuleOperations(canWrite: boolean) {
  const access = usePolicyEditorAccess(canWrite);
  const guard = usePolicyWriteGuard(access);
  const client = useQueryClient();
  const key = ["governance", "alerts", access.sessionKey] as const;
  const selections = useRef<Partial<Record<Review, AlertRule>>>({});
  const alerts = useQuery({
    queryKey: key,
    enabled: access.read,
    gcTime: 0,
    retry: false,
    queryFn: ({ signal }) => {
      access.assertRead();
      return apiClient.request(endpoints.domains.governance.alerts.list, { signal, routeId });
    },
  });
  const current = (row: AlertRule) => catalogRecordCurrent(client, key, "rules", row);
  const ownsResult = () => {
    try {
      access.assertRead();
      return true;
    } catch {
      return false;
    }
  };
  const assertRecord = (row: AlertRule, review?: Review) => {
    if (!current(row) || (review && selections.current[review] !== row))
      throw new AppError("알림 규칙을 다시 조회하고 검토하세요.", { kind: "permission" });
  };
  const beginReview = (kind: Review, row: AlertRule) => {
    if (!guard.canOpen() || !current(row)) return undefined;
    const snapshot = structuredClone(row);
    selections.current[kind] = snapshot;
    return snapshot;
  };
  const clearReview = (kind: Review) => {
    selections.current[kind] = undefined;
  };
  const feedback = { ownsResult, invalidates: [key] };
  const createRule = useMutationFeedback({
    ...feedback,
    mutate: (body: AlertRuleBody) =>
      guard.run("create", () =>
        apiClient.request(endpoints.domains.governance.alerts.create, {
          body,
          routeId,
          retryUnauthorized: false,
        }),
      ),
    successMessage: "알림 규칙을 추가했습니다.",
    errorMessage: "알림 규칙을 추가하지 못했습니다.",
  });
  const updateRule = useMutationFeedback({
    ...feedback,
    mutate: ({ row, body }: { row: AlertRule; body: AlertRuleUpdateBody }) =>
      guard.run(`rule:${row.id}`, () => {
        assertRecord(row, "edit");
        return apiClient.request(withPathParams(endpoints.domains.governance.alerts.update, { id: row.id }), {
          body,
          routeId,
          retryUnauthorized: false,
        });
      }),
    successMessage: "알림 규칙을 수정했습니다.",
    errorMessage: "알림 규칙을 수정하지 못했습니다.",
  });
  const toggleRule = useMutationFeedback({
    ...feedback,
    mutate: ({ row, enabled }: { row: AlertRule; enabled: boolean }) =>
      guard.run(`rule:${row.id}`, () => {
        assertRecord(row);
        return apiClient.request(withPathParams(endpoints.domains.governance.alerts.update, { id: row.id }), {
          body: { enabled },
          routeId,
          retryUnauthorized: false,
        });
      }),
    successMessage: (_result, variables) =>
      variables.enabled ? "알림 규칙을 사용합니다." : "알림 규칙을 중지했습니다.",
    errorMessage: "알림 규칙 사용 여부를 바꾸지 못했습니다.",
  });
  const removeRule = useMutationFeedback({
    ...feedback,
    mutate: (row: AlertRule) =>
      guard.run(`rule:${row.id}`, () => {
        assertRecord(row, "delete");
        return apiClient.request(withPathParams(endpoints.domains.governance.alerts.remove, { id: row.id }), {
          routeId,
          retryUnauthorized: false,
        });
      }),
    successMessage: "알림 규칙을 삭제했습니다.",
    errorMessage: "알림 규칙을 삭제하지 못했습니다.",
  });
  const actionable = (row: AlertRule) =>
    access.write.allowed && current(row) && !guard.pending.has(`rule:${row.id}`);
  const visible = access.read && alerts.isSuccess && !alerts.isFetching;
  return {
    access,
    guard,
    alerts,
    actionable,
    beginReview,
    clearReview,
    createRule,
    updateRule,
    toggleRule,
    removeRule,
    ruleRows: visible ? (alerts.data.rules ?? []) : [],
    eventRows: visible ? (alerts.data.events ?? []) : [],
  };
}
