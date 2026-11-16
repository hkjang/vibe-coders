import { useAuth } from "@/app/auth/AuthProvider";
import { containsPotentialSecret } from "@/shared/security/secrets";

export function useSystemText() {
  const { credentialPrefixes } = useAuth();
  return (value: string | null | undefined, fallback = "비공개"): string =>
    value && !containsPotentialSecret(value, credentialPrefixes) ? value : fallback;
}
export const workerLabels: Record<string, string> = {
  async_logger: "요청 로그 기록",
  clickhouse_fact_queue: "분석 데이터 대기열",
  clickhouse_sink: "ClickHouse 적재",
  clickhouse_fact_retry: "분석 데이터 재처리",
  retention: "보존 기간 정리",
  text2sql_report_scheduler: "자연어 SQL 예약 보고서",
};
export const cardLabels: Record<string, string> = {
  cost_spike: "비용 급증",
  degraded_provider: "공급자 상태",
  risky_skills: "위험 스킬",
  mcp_failures: "MCP 호출 실패",
  text2sql_blocks: "자연어 SQL 차단",
  clickhouse_lag: "ClickHouse 적재",
};
export const categoryLabels: Record<string, string> = {
  cost: "비용",
  routing: "라우팅",
  security: "보안",
  mcp: "MCP",
  text2sql: "자연어 SQL",
  skills: "스킬",
  data: "데이터",
};
export const preflightLabels: Record<string, string> = {
  db_reachable: "데이터베이스 연결",
  migrations: "데이터베이스 구성",
  db_migration: "데이터베이스 구성",
  openapi: "API 명세",
  upstream: "기본 공급자 연결",
  secret_cipher: "비밀정보 암호화",
  auth_secret: "인증 비밀정보",
};
