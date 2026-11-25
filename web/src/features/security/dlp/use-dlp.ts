import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import {
  dlpRejectionSchema,
  type DLPConfig,
  type DLPEventsQuery,
  type DLPIssue,
} from "@/shared/api/domains/security-dlp";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

export const dlpFeatureId = "security.dlp";
export const dlpKey = ["security", "dlp"] as const;
const api = endpoints.domains.securityDlp;

export function useDLPSettings() {
  return useQuery({
    queryKey: [...dlpKey, "settings"],
    queryFn: ({ signal }) => apiClient.request(api.settings, { signal, routeId: dlpFeatureId }),
  });
}

export function useDLPEvents(query: DLPEventsQuery, refetchInterval: number | false) {
  return useQuery({
    queryKey: [...dlpKey, "events", query],
    placeholderData: keepPreviousData,
    refetchInterval,
    queryFn: ({ signal }) => apiClient.request(api.events, { query, signal, routeId: dlpFeatureId }),
  });
}

/** The per-field issues carried by a 422, if that is what the error is. */
export function rejectionIssues(error: unknown): DLPIssue[] | undefined {
  if (!isAppError(error) || error.status !== 422) return undefined;
  const parsed = dlpRejectionSchema.safeParse(error.details);
  return parsed.success ? parsed.data.issues : undefined;
}

export function isConflict(error: unknown): boolean {
  return isAppError(error) && error.code === "dlp_conflict";
}

const errorMessages: Readonly<Record<string, string>> = {
  dlp_conflict: "다른 운영자가 먼저 DLP 설정을 저장했습니다. 최신 설정을 불러온 뒤 변경을 다시 적용하세요.",
  dlp_config_invalid: "설정에 오류가 있어 저장하지 않았습니다. 표시된 항목을 고친 뒤 다시 시도하세요.",
  dlp_revision_missing: "편집을 시작한 설정 버전을 알 수 없습니다. 새로고침한 뒤 다시 시도하세요.",
  dlp_test_text_invalid: "검사할 텍스트는 1바이트에서 1MiB 사이여야 합니다.",
};

export function dlpErrorMessage(error: unknown): string {
  if (isAppError(error) && error.code && errorMessages[error.code])
    return errorMessages[error.code] as string;
  return safeAppErrorMessage(error, "요청을 처리하지 못했습니다.");
}

export function useDLPWrites() {
  const auth = useAuth();
  const canWrite = auth.mode !== "authenticated" || (auth.user?.scopes.includes("admin:write") ?? false);
  const access = useFeatureMutationAccess(
    [dlpFeatureId],
    canWrite,
    "DLP 설정을 바꾸려면 admin:write 권한이 필요합니다.",
  );
  const save = useMutationFeedback({
    mutate: (input: { config: DLPConfig; expectedRevision: number; reason: string }) => {
      access.assertCurrent();
      return apiClient.request(api.save, {
        body: { config: input.config, expected_revision: input.expectedRevision, reason: input.reason },
        routeId: dlpFeatureId,
        retryUnauthorized: false,
      });
    },
    observation: "save",
    invalidates: [[...dlpKey, "settings"]],
    successMessage: (result) =>
      `DLP 설정을 저장했습니다(버전 ${result.revision}). 모든 게이트웨이에 5초 안에 반영됩니다.`,
    errorFormatter: dlpErrorMessage,
  });
  return { access, save } as const;
}

export function useDLPTest() {
  return useMutationFeedback({
    mutate: (input: { text: string; config?: DLPConfig; teamId?: string; apiKeyId?: string }) =>
      apiClient.request(api.test, {
        body: {
          text: input.text,
          ...(input.config ? { config: input.config } : {}),
          ...(input.teamId ? { team_id: input.teamId } : {}),
          ...(input.apiKeyId ? { api_key_id: input.apiKeyId } : {}),
        },
        routeId: dlpFeatureId,
      }),
    observation: "test",
    errorFormatter: dlpErrorMessage,
  });
}
