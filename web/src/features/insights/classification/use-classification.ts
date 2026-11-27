import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import {
  workJobSchema,
  workPolicyRejectionSchema,
  type WorkJob,
  type WorkPolicyConfig,
  type WorkPolicyIssue,
  type WorkReclassifyQuery,
  type WorkReviewQuery,
} from "@/shared/api/domains/insights-classification";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

import {
  jobPollInterval,
  reclassifyConflictKind,
  reclassifyConflictMessages,
  type ReclassifyConflict,
} from "./classification-model";

export const classificationFeatureId = "insights.classification";
export const classificationKey = ["insights", "classification"] as const;
const api = endpoints.domains.insightsClassification;
const routeId = classificationFeatureId;

/** A missing or switched-off API is a state of the screen, not a transient failure. */
function retry(failureCount: number, error: unknown): boolean {
  return (
    failureCount < 1 &&
    isAppError(error) &&
    error.retryable &&
    error.status !== 429 &&
    unavailableKind(error) === undefined
  );
}

export type Unavailable = "not_implemented" | "disabled";

/**
 * Whether the gateway answered that work intelligence is not there (an older
 * gateway, 501) or is switched off, as opposed to failing.
 */
export function unavailableKind(error: unknown): Unavailable | undefined {
  if (!isAppError(error)) return undefined;
  if (error.status === 501 || error.code === "work_intel_not_implemented") return "not_implemented";
  if (error.code !== undefined && /^work_intel_.*disabled$/u.test(error.code)) return "disabled";
  return undefined;
}

export function useWorkStatus(refetchInterval: number | false = false) {
  return useQuery({
    queryKey: [...classificationKey, "status"],
    retry,
    refetchInterval,
    queryFn: ({ signal }) => apiClient.request(api.status, { signal, routeId }),
  });
}

export function useWorkPolicy() {
  return useQuery({
    queryKey: [...classificationKey, "policy"],
    retry,
    queryFn: ({ signal }) => apiClient.request(api.policy, { signal, routeId }),
  });
}

export function useWorkVersions(enabled = true) {
  return useQuery({
    queryKey: [...classificationKey, "versions"],
    retry,
    enabled,
    queryFn: ({ signal }) => apiClient.request(api.versions, { signal, routeId }),
  });
}

/** One published version's full document; `undefined` or 0 reads nothing. */
export function useWorkVersion(version: number | undefined) {
  return useQuery({
    queryKey: [...classificationKey, "version", version ?? 0],
    retry,
    enabled: version !== undefined && version > 0,
    // A published version never changes.
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(api.version, { version: version ?? 0 }), { signal, routeId }),
  });
}

export function useWorkReview(query: WorkReviewQuery, enabled = true) {
  return useQuery({
    queryKey: [...classificationKey, "review", query],
    retry,
    enabled,
    placeholderData: keepPreviousData,
    queryFn: ({ signal }) => apiClient.request(api.review, { query, signal, routeId }),
  });
}

/** Polls a reclassification job until it has finished. */
export function useWorkJob(id: string) {
  return useQuery<WorkJob>({
    queryKey: [...classificationKey, "job", id],
    retry,
    enabled: id !== "",
    refetchInterval: (query) => (query.state.error ? false : jobPollInterval(query.state.data)),
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(api.reclassifyJob, { id }), { signal, routeId }),
  });
}

/** The per-field issues carried by a 422, if that is what the error is. */
export function rejectionIssues(error: unknown): WorkPolicyIssue[] | undefined {
  if (!isAppError(error) || error.status !== 422) return undefined;
  const parsed = workPolicyRejectionSchema.safeParse(error.details);
  return parsed.success ? parsed.data.issues : undefined;
}

export function isPolicyConflict(error: unknown): boolean {
  return isAppError(error) && (error.code === "work_policy_conflict" || error.status === 409);
}

export function reclassifyConflict(error: unknown): ReclassifyConflict | undefined {
  return isAppError(error) ? reclassifyConflictKind(error.code) : undefined;
}

/** The running job a `work_job_active` refusal names, when the server sent it along. */
export function activeJobFrom(error: unknown): WorkJob | undefined {
  if (!isAppError(error) || typeof error.details !== "object" || error.details === null) return undefined;
  const details = error.details as Record<string, unknown>;
  const parsed = workJobSchema.safeParse(details.active_job ?? details.job);
  return parsed.success ? parsed.data : undefined;
}

const errorMessages: Readonly<Record<string, string>> = {
  work_policy_conflict:
    "다른 운영자가 먼저 분류 정책 초안을 저장했습니다. 최신 초안을 불러온 뒤 변경을 다시 적용하세요.",
  work_policy_invalid: "정책에 오류가 있어 저장하지 않았습니다. 표시된 항목을 고친 뒤 다시 시도하세요.",
  work_intel_not_implemented: "이 게이트웨이에는 업무 분류 API가 아직 없습니다.",
  work_reclassify_expired: reclassifyConflictMessages.expired,
  work_reclassify_conflict: reclassifyConflictMessages.conflict,
  work_job_active: reclassifyConflictMessages.job_active,
};

export function classificationErrorMessage(error: unknown, fallback = "요청을 처리하지 못했습니다."): string {
  if (isAppError(error) && error.code && errorMessages[error.code])
    return errorMessages[error.code] as string;
  if (unavailableKind(error) === "disabled")
    return "업무 분류 기능이 꺼져 있습니다. 시스템 설정에서 켠 뒤 다시 시도하세요.";
  return safeAppErrorMessage(error, fallback);
}

export const writeScopeReason = "분류 정책을 바꾸려면 admin:write 권한이 필요합니다.";

/** Persistent changes: saving, publishing, rolling back, correcting, reclassifying, rebuilding. */
export function useClassificationWrites() {
  const auth = useAuth();
  const hasWriteScope = auth.mode !== "authenticated" || (auth.user?.scopes.includes("admin:write") ?? false);
  const access = useFeatureMutationAccess([classificationFeatureId], hasWriteScope, writeScopeReason);

  const save = useMutationFeedback({
    mutate: (input: { config: WorkPolicyConfig; expectedRevision: number; reason: string }) => {
      access.assertCurrent();
      return apiClient.request(api.savePolicy, {
        body: { config: input.config, expected_revision: input.expectedRevision, reason: input.reason },
        routeId,
        retryUnauthorized: false,
      });
    },
    observation: "save",
    invalidates: [[...classificationKey, "policy"]],
    successMessage: (result) =>
      `초안을 저장했습니다(리비전 ${result.revision}). 배포하기 전에는 분류가 바뀌지 않습니다.`,
    errorFormatter: classificationErrorMessage,
  });

  const publish = useMutationFeedback({
    mutate: (input: { expectedRevision: number; note: string }) => {
      access.assertCurrent();
      return apiClient.request(api.publish, {
        body: { expected_revision: input.expectedRevision, note: input.note },
        routeId,
        retryUnauthorized: false,
      });
    },
    observation: "activate",
    invalidates: [
      [...classificationKey, "policy"],
      [...classificationKey, "versions"],
      [...classificationKey, "status"],
    ],
    successMessage: (result) => `정책 버전 ${result.version} 배포를 마쳤습니다.`,
    errorFormatter: classificationErrorMessage,
  });

  const rollback = useMutationFeedback({
    mutate: (input: { version: number; note: string }) => {
      access.assertCurrent();
      return apiClient.request(api.rollback, {
        body: { version: input.version, note: input.note },
        routeId,
        retryUnauthorized: false,
      });
    },
    observation: "rollback",
    invalidates: [
      [...classificationKey, "policy"],
      [...classificationKey, "versions"],
      [...classificationKey, "status"],
    ],
    successMessage: (result, input) =>
      `버전 ${input.version}의 내용을 다시 배포했습니다${result.version ? ` (새 버전 ${result.version})` : ""}.`,
    errorFormatter: classificationErrorMessage,
  });

  const correct = useMutationFeedback({
    mutate: (input: { requestIds: string[]; categoryId: string; actionType: string; reason: string }) => {
      access.assertCurrent();
      return apiClient.request(api.correct, {
        body: {
          request_ids: input.requestIds,
          category_id: input.categoryId,
          ...(input.actionType ? { action_type: input.actionType } : {}),
          reason: input.reason,
        },
        routeId,
        retryUnauthorized: false,
      });
    },
    observation: "save",
    invalidates: [
      [...classificationKey, "review"],
      [...classificationKey, "status"],
    ],
    successMessage: (result) => `${result.corrected.toLocaleString("ko-KR")}건의 분류를 보정했습니다.`,
    errorFormatter: classificationErrorMessage,
  });

  const reclassify = useMutationFeedback({
    mutate: (input: { revision: string; reviewedAt: string; reason: string }) => {
      access.assertCurrent();
      return apiClient.request(api.reclassifyRun, {
        query: { reviewed: "1" },
        body: { revision: input.revision, reviewed_at: input.reviewedAt, reason: input.reason },
        routeId,
        retryUnauthorized: false,
      });
    },
    observation: "run_request",
    successMessage: "재분류 작업을 시작했습니다.",
    errorFormatter: classificationErrorMessage,
  });

  const rebuild = useMutationFeedback({
    mutate: (input: { from: string; to: string; reason: string }) => {
      access.assertCurrent();
      return apiClient.request(api.rebuild, {
        body: { from: input.from, to: input.to, reason: input.reason },
        routeId,
        retryUnauthorized: false,
      });
    },
    observation: "run_request",
    successMessage: (_result, input) => `${input.from} ~ ${input.to} 집계를 다시 만들었습니다.`,
    errorFormatter: classificationErrorMessage,
  });

  return { access, hasWriteScope, save, publish, rollback, correct, reclassify, rebuild } as const;
}

export interface PolicyTestInput {
  text: string;
  taskType: string;
  languages: string[];
  mcpTools: string[];
  client: string;
  model: string;
  useDraft: boolean;
  useLLM: boolean;
}

/** Dry runs: they are POSTs (admin:write on the server) but change nothing. */
export function useClassificationTests() {
  const test = useMutationFeedback({
    mutate: (input: PolicyTestInput) =>
      apiClient.request(api.test, {
        body: {
          text: input.text,
          ...(input.taskType ? { task_type: input.taskType } : {}),
          ...(input.languages.length > 0 ? { languages: input.languages } : {}),
          ...(input.mcpTools.length > 0 ? { mcp_tools: input.mcpTools } : {}),
          ...(input.client ? { client: input.client } : {}),
          ...(input.model ? { model: input.model } : {}),
          use_draft: input.useDraft,
          use_llm: input.useLLM,
        },
        routeId,
      }),
    observation: "test",
    errorFormatter: classificationErrorMessage,
  });
  const evaluate = useMutationFeedback({
    mutate: (input: { useDraft: boolean; limit: number }) =>
      apiClient.request(api.evaluate, {
        body: { use_draft: input.useDraft, limit: input.limit },
        routeId,
      }),
    observation: "test",
    errorFormatter: classificationErrorMessage,
  });
  return { test, evaluate } as const;
}

/** The impact preview of a reclassification: a read whose result a run must present. */
export function useReclassifyPreview() {
  return useMutationFeedback({
    mutate: (query: WorkReclassifyQuery) => apiClient.request(api.reclassifyPreview, { query, routeId }),
    observation: false,
    errorFormatter: classificationErrorMessage,
  });
}
