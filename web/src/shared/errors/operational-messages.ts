import { isAppError } from "@/shared/api/error";

const operationalMessages = {
  auth_disabled: "인증 기능이 비활성화되어 있습니다.",
  dev_secret: "개발용 기본 비밀정보를 사용 중입니다.",
  pricing_missing: "모델 가격표가 없어 비용을 추적할 수 없습니다.",
  raw_prompts: "프롬프트 원문 저장이 활성화되어 있습니다.",
  raw_bodies: "요청과 응답 원문 저장이 활성화되어 있습니다.",
  log_drops: "일부 감사 로그가 기록되지 않았습니다.",
  fallback_backlog: "처리되지 않은 대체 응답 로그가 있습니다.",
  disk_usage_unavailable: "데이터 디스크 사용량을 확인할 수 없습니다.",
  disk_low: "데이터 디스크 사용률이 위험 수준입니다.",
  disk_warning: "데이터 디스크 사용률이 높습니다.",
  provider_degraded: "공급자 상태 점수가 임계값보다 낮습니다.",
  timeouts_detected: "선택 기간에 시간 초과 신호가 감지되었습니다.",
  rate_limit_detected: "선택 기간에 HTTP 429 응답이 감지되었습니다.",
  server_error_detected: "선택 기간에 공급자 HTTP 5xx 응답이 감지되었습니다.",
  fallback_rate_high: "선택 기간의 장애 전환 비율이 높습니다.",
  provider_health_unavailable: "공급자 상태 데이터를 일시적으로 확인할 수 없습니다.",
  fallback_stats_unavailable: "대체 응답 로그 통계를 일시적으로 확인할 수 없습니다.",
  agent_routes_unavailable: "가상 모델 카탈로그를 일시적으로 확인할 수 없습니다.",
  models_response_limit_exceeded: "지원 한도로 인해 모델 카탈로그 응답 일부가 생략되었습니다.",
  models_provider_limit_exceeded: "지원 가능한 공급자 수 한도로 인해 일부 공급자가 생략되었습니다.",
  provider_credentials_unavailable: "공급자 인증정보를 확인할 수 없습니다.",
  provider_models_limit_exceeded: "공급자 모델 카탈로그가 지원 한도를 초과했습니다.",
  provider_models_unavailable: "공급자 모델 카탈로그를 일시적으로 확인할 수 없습니다.",
  provider_models_stale: "공급자 갱신에 실패해 마지막 정상 모델 카탈로그를 표시합니다.",
} as const;

export function operationalMessage(code: string | undefined, fallback: string): string {
  const normalized = code?.trim();
  if (!normalized || !Object.prototype.hasOwnProperty.call(operationalMessages, normalized)) {
    return fallback;
  }
  return operationalMessages[normalized as keyof typeof operationalMessages];
}

export function safeAppErrorMessage(error: unknown, fallback: string): string {
  if (!isAppError(error)) return fallback;

  const codedMessage = operationalMessage(error.code, "");
  if (codedMessage) return codedMessage;

  switch (error.kind) {
    case "aborted":
      return "요청이 취소되었습니다.";
    case "auth":
      return "인증 정보가 올바르지 않거나 만료되었습니다.";
    case "contract":
      return "서버 응답 형식을 확인할 수 없습니다.";
    case "network":
      return "게이트웨이에 연결할 수 없습니다.";
    case "permission":
      return "이 작업을 수행할 권한이 없습니다.";
    case "timeout":
      return "API 요청 시간이 초과되었습니다.";
    case "http":
      if (error.status === 401) return "인증 정보가 올바르지 않거나 만료되었습니다.";
      if (error.status === 403) return "이 작업을 수행할 권한이 없습니다.";
      if (error.status === 429) return "요청이 너무 많습니다. 잠시 후 다시 시도하세요.";
      if (error.status !== undefined && error.status >= 500) {
        return "서버가 요청을 처리하지 못했습니다. 잠시 후 다시 시도하세요.";
      }
      return fallback;
  }

  return fallback;
}
