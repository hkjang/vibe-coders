import { describe, expect, it } from "vitest";

import { AppError } from "@/shared/api/error";
import { operationalMessage, safeAppErrorMessage } from "@/shared/errors/operational-messages";

describe("operationalMessage", () => {
  it.each([
    ["invalid_operation_reason", "사유는 1~1,024자입니다."],
    ["operation_audit_unavailable", "감사 저장 실패: 실행 안 됨."],
    ["operation_result_unconfirmed", "실행 여부 불명: 감사·상태 확인 후 재실행하세요."],
    ["retention_run_incomplete", "실패 또는 부분 완료: 감사·상태를 확인하세요."],
    ["fallback_replay_failed", "실패 또는 부분 완료: 감사·상태를 확인하세요."],
    ["retention_status_unavailable", "건수 조회 실패: 정리 결과 확인 필요."],
    ["provider_degraded", "공급자 상태 점수가 임계값보다 낮습니다."],
    ["timeouts_detected", "선택 기간에 시간 초과 신호가 감지되었습니다."],
    ["rate_limit_detected", "선택 기간에 HTTP 429 응답이 감지되었습니다."],
    ["server_error_detected", "선택 기간에 공급자 HTTP 5xx 응답이 감지되었습니다."],
    ["fallback_rate_high", "선택 기간의 장애 전환 비율이 높습니다."],
    ["provider_health_unavailable", "공급자 상태 데이터를 일시적으로 확인할 수 없습니다."],
    ["fallback_stats_unavailable", "대체 응답 로그 통계를 일시적으로 확인할 수 없습니다."],
    ["agent_routes_unavailable", "가상 모델 카탈로그를 일시적으로 확인할 수 없습니다."],
    ["provider_models_unavailable", "공급자 모델 카탈로그를 일시적으로 확인할 수 없습니다."],
    ["models_response_limit_exceeded", "지원 한도로 인해 모델 카탈로그 응답 일부가 생략되었습니다."],
    ["models_provider_limit_exceeded", "지원 가능한 공급자 수 한도로 인해 일부 공급자가 생략되었습니다."],
    ["provider_credentials_unavailable", "공급자 인증정보를 확인할 수 없습니다."],
    ["provider_models_limit_exceeded", "공급자 모델 카탈로그가 지원 한도를 초과했습니다."],
    ["provider_models_stale", "공급자 갱신에 실패해 마지막 정상 모델 카탈로그를 표시합니다."],
  ])("maps %s to a stable Korean message", (code, expected) => {
    expect(operationalMessage(code, "일반 안내")).toBe(expected);
  });

  it("uses a stable caller message for an unknown code", () => {
    expect(operationalMessage("unknown_sensitive_detail", "상세 내용을 확인할 수 없습니다.")).toBe(
      "상세 내용을 확인할 수 없습니다.",
    );
  });

  it("does not reflect a raw AppError message", () => {
    const error = new AppError("private upstream detail", {
      kind: "http",
      code: "unknown_server_code",
      status: 400,
    });

    expect(safeAppErrorMessage(error, "데이터를 확인할 수 없습니다.")).toBe("데이터를 확인할 수 없습니다.");
  });

  it("maps a known AppError code before using its kind fallback", () => {
    const error = new AppError("Provider model catalog is unavailable.", {
      kind: "http",
      code: "provider_models_unavailable",
      status: 502,
    });

    expect(safeAppErrorMessage(error, "데이터를 확인할 수 없습니다.")).toBe(
      "공급자 모델 카탈로그를 일시적으로 확인할 수 없습니다.",
    );
  });
});
