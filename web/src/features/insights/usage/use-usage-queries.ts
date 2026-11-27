import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import type { WorkQuery } from "@/shared/api/domains/insights-common";
import type {
  AutomationReviewStatus,
  WorkRequestsQuery,
  WorkSessionsQuery,
  WorkTrendBucket,
} from "@/shared/api/domains/insights-usage";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { assertFeatureRead, featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";

import { useUsageOwner } from "./usage-read-context";

export const usageFeatureId = "insights.usage";
export const usageKey = ["insights", "usage"] as const;
const api = endpoints.domains.insightsUsage;
const routeId = usageFeatureId;

export interface UsageRead<Data> {
  data: Data | undefined;
  error: unknown;
  isPending: boolean;
  isError: boolean;
  isFetching: boolean;
  /** The data on screen answers the previous filters while the new ones load. */
  isPrevious: boolean;
  dataUpdatedAt: number;
  refetch: () => void;
}

/**
 * One panel's read. A failure stays inside its panel; a refresh failure keeps the
 * last good data; a forbidden read discards what it had.
 */
function useUsageRead<Data>(
  name: string,
  query: unknown,
  read: (signal: AbortSignal) => Promise<Data>,
  enabled = true,
): UsageRead<Data> {
  const owner = useUsageOwner();
  const allowed = owner.readable && !owner.denied;
  const interval = useRefreshInterval();
  const active = enabled && allowed;
  const result = useQuery({
    queryKey: featureOwnedKey([...usageKey, name, query], owner),
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await read(signal);
      assertFeatureRead(owner, signal);
      return data;
    },
    enabled: active,
    retry: false,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    refetchInterval: active ? interval : false,
    refetchIntervalInBackground: false,
  });
  const forbidden = !allowed || (isAppError(result.error) && [401, 403].includes(result.error.status ?? 0));
  const error = forbidden
    ? new AppError("현재 계정의 조회 권한을 확인하세요.", { kind: "permission", status: 403 })
    : result.error;
  const visible = active && !forbidden;
  return {
    data: visible ? result.data : undefined,
    error,
    isPending: active && result.isPending,
    isError: Boolean(error),
    isFetching: active && result.isFetching,
    isPrevious: visible && result.isPlaceholderData,
    dataUpdatedAt: visible ? result.dataUpdatedAt : 0,
    refetch: () => {
      if (!enabled) return;
      if (owner.denied) owner.restart();
      else if (owner.isCurrent()) void result.refetch();
    },
  };
}

export function useUsageStatus() {
  return useUsageRead("status", undefined, (signal) => apiClient.request(api.status, { signal, routeId }));
}

export function useOverview(query: WorkQuery, enabled = true) {
  return useUsageRead(
    "overview",
    query,
    (signal) => apiClient.request(api.overview, { query, signal, routeId }),
    enabled,
  );
}

export function useCategories(base: WorkQuery, parent: string, enabled = true) {
  const query = { ...base, ...(parent ? { parent } : {}) };
  return useUsageRead(
    "categories",
    query,
    (signal) => apiClient.request(api.categories, { query, signal, routeId }),
    enabled,
  );
}

export function useTrend(base: WorkQuery, bucket: WorkTrendBucket, top = 8, enabled = true) {
  const query = { ...base, bucket, top };
  return useUsageRead(
    "trend",
    query,
    (signal) => apiClient.request(api.trend, { query, signal, routeId }),
    enabled,
  );
}

export function useMatrix(base: WorkQuery, top = 12, enabled = true) {
  const query = { ...base, top };
  return useUsageRead(
    "matrix",
    query,
    (signal) => apiClient.request(api.matrix, { query, signal, routeId }),
    enabled,
  );
}

export function useFlow(base: WorkQuery, top = 6, enabled = true) {
  const query = { ...base, top };
  return useUsageRead(
    "flow",
    query,
    (signal) => apiClient.request(api.flow, { query, signal, routeId }),
    enabled,
  );
}

export function useTeams(query: WorkQuery, enabled = true) {
  return useUsageRead(
    "teams",
    query,
    (signal) => apiClient.request(api.teams, { query, signal, routeId }),
    enabled,
  );
}

export function useModels(query: WorkQuery, enabled = true) {
  return useUsageRead(
    "models",
    query,
    (signal) => apiClient.request(api.models, { query, signal, routeId }),
    enabled,
  );
}

export function useTrendSignals(query: WorkQuery, enabled = true) {
  return useUsageRead(
    "trends",
    query,
    (signal) => apiClient.request(api.trends, { query, signal, routeId }),
    enabled,
  );
}

/** `status` on this read is the review status, not the classification status. */
export function useAutomation(base: WorkQuery, review: AutomationReviewStatus | "", enabled = true) {
  const query: WorkQuery = { ...base, ...(review ? { status: review } : {}) };
  return useUsageRead(
    "automation",
    query,
    (signal) => apiClient.request(api.automation, { query, signal, routeId }),
    enabled,
  );
}

export function useInsights(query: WorkQuery, enabled = true) {
  return useUsageRead(
    "insights",
    query,
    (signal) => apiClient.request(api.insights, { query, signal, routeId }),
    enabled,
  );
}

export function useSessions(query: WorkSessionsQuery, enabled = true) {
  return useUsageRead(
    "sessions",
    query,
    (signal) => apiClient.request(api.sessions, { query, signal, routeId }),
    enabled,
  );
}

export function useSessionDetail(sessionId: string) {
  return useUsageRead(
    "session",
    sessionId,
    (signal) => apiClient.request(withPathParams(api.session, { id: sessionId }), { signal, routeId }),
    sessionId !== "",
  );
}

export function useRequests(query: WorkRequestsQuery, enabled = true) {
  return useUsageRead(
    "requests",
    query,
    (signal) => apiClient.request(api.requests, { query, signal, routeId }),
    enabled,
  );
}

export function useProductivity(query: WorkQuery, enabled = true) {
  return useUsageRead(
    "productivity",
    query,
    (signal) => apiClient.request(api.productivity, { query, signal, routeId }),
    enabled,
  );
}

const writeErrorMessages: Readonly<Record<string, string>> = {
  work_intel_team_forbidden:
    "다른 조직도 포함된 후보라서 팀 범위 관리자는 검토 상태를 기록할 수 없습니다. 조직 전체 관리자에게 요청하세요.",
};

/** A write failure as an operator message; the server's known refusals get their own wording. */
export function usageWriteErrorMessage(error: unknown, fallback: string): string {
  if (isAppError(error) && error.code && Object.hasOwn(writeErrorMessages, error.code)) {
    return writeErrorMessages[error.code] as string;
  }
  return safeAppErrorMessage(error, fallback);
}

/** The two writes of this screen. Both need admin:write; neither registers nor runs an automation. */
export function useUsageWrites() {
  const auth = useAuth();
  const canWrite = auth.mode !== "authenticated" || (auth.user?.scopes.includes("admin:write") ?? false);
  const access = useFeatureMutationAccess(
    [usageFeatureId],
    canWrite,
    "검토 상태를 바꾸거나 다시 계산하려면 admin:write 권한이 필요합니다.",
  );
  const review = useMutationFeedback({
    mutate: (input: { id: string; reviewStatus: AutomationReviewStatus; note: string }) => {
      access.assertCurrent();
      return apiClient.request(withPathParams(api.automationReview, { id: input.id }), {
        body: { review_status: input.reviewStatus, note: input.note },
        routeId,
        retryUnauthorized: false,
      });
    },
    observation: "save",
    invalidates: [[...usageKey, "automation"]],
    successMessage: "검토 상태를 기록했습니다. 자동 등록이나 실행은 하지 않습니다.",
    errorMessage: "검토 상태를 기록하지 못했습니다.",
    errorFormatter: usageWriteErrorMessage,
  });
  const runInsights = useMutationFeedback({
    mutate: () => {
      access.assertCurrent();
      return apiClient.request(api.insightsRun, { routeId, retryUnauthorized: false });
    },
    observation: "run_request",
    invalidates: [
      [...usageKey, "insights"],
      [...usageKey, "trends"],
      [...usageKey, "automation"],
      [...usageKey, "overview"],
    ],
    successMessage: (result: { generated: number }) =>
      `트렌드·자동화 후보·인사이트를 다시 계산했습니다(인사이트 ${result.generated}건).`,
    errorMessage: "다시 계산하지 못했습니다.",
  });
  return { access, review, runInsights } as const;
}
