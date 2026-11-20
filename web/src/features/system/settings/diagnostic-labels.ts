import type { UIDiagnosticsSummary } from "@/shared/api/domains/ui-diagnostics";

type Diagnostic = UIDiagnosticsSummary["recent"][number];
export const diagnosticFailureLabels: Record<Diagnostic["failure"], string> = {
  http: "서버 오류 응답",
  auth: "인증 실패",
  permission: "권한 부족",
  contract: "응답 형식 오류",
  network: "연결 실패",
  timeout: "시간 초과",
  error: "일반 화면 오류",
  type: "자료형 오류",
  range: "범위 오류",
  reference: "참조 오류",
  syntax: "구문 오류",
  uri: "주소 처리 오류",
  eval: "코드 평가 오류",
  aggregate: "복합 오류",
  unknown: "분류되지 않은 오류",
};
export const diagnosticKindLabels: Record<Diagnostic["kind"], string> = {
  api_error: "API 오류",
  js_error: "화면 오류",
};
export function diagnosticSource(row: Pick<Diagnostic, "kind" | "method" | "endpoint" | "boundary">): string {
  return row.kind === "api_error"
    ? `${row.method} ${row.endpoint}`
    : row.boundary === "root"
      ? "콘솔 화면 경계"
      : "화면 이동 경계";
}
