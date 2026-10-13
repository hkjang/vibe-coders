import { z } from "zod";

export const alertMetrics = [
  { value: "requests", label: "요청 수" },
  { value: "errors", label: "오류율(0-1)" },
  { value: "krw", label: "KRW 비용" },
  { value: "tokens", label: "토큰" },
  { value: "latency_p95_ms", label: "전체 지연 P95" },
  { value: "first_chunk_p95_ms", label: "첫 청크 P95" },
  { value: "llm_eval_failures", label: "LLM 평가 실패 수" },
  { value: "llm_eval_failure_rate", label: "LLM 평가 실패율" },
  { value: "tool_errors", label: "도구 오류 수" },
  { value: "tool_error_rate", label: "도구 오류율" },
  { value: "tool_loop", label: "에이전트 루프" },
  { value: "mcp_new_tools", label: "MCP 신규 도구 수" },
  { value: "anomaly_zmax", label: "이상 징후 z-score" },
  { value: "budget_burn_ratio", label: "예산 소진 예측 비율" },
  { value: "failover_rate", label: "폴백 발생률" },
  { value: "failovers", label: "폴백 발생 건수" },
] as const;

export const alertScopes = [
  { value: "global", label: "전체" },
  { value: "api_key", label: "API 키" },
  { value: "team", label: "팀" },
  { value: "ip", label: "IP" },
  { value: "model", label: "모델" },
] as const;

export const metricLabels = new Map<string, string>(
  alertMetrics.map((metric) => [metric.value, metric.label]),
);
export const scopeLabels = new Map<string, string>(alertScopes.map((scope) => [scope.value, scope.label]));

export const alertFormSchema = z.object({
  name: z.string().trim().min(1, "이름을 입력하세요."),
  metric: z.string().trim().min(1),
  scope: z.string().trim().min(1),
  scopeValue: z.string().trim().max(200),
  windowSeconds: z.coerce.number().int().min(30).max(86_400),
  threshold: z.coerce.number().positive("임계값은 0보다 커야 합니다."),
  webhookUrl: z.string().trim().max(500),
  note: z.string().trim().max(500),
});
export type AlertFormValues = z.output<typeof alertFormSchema>;
export type AlertFormInput = z.input<typeof alertFormSchema>;

// PATCH accepts only the operational fields; metric/scope/window are fixed at creation.
export const alertEditSchema = z.object({
  threshold: z.coerce.number().positive("임계값은 0보다 커야 합니다."),
  webhookUrl: z.string().trim().max(500),
  note: z.string().trim().max(500),
});
export type AlertEditValues = z.output<typeof alertEditSchema>;
export type AlertEditInput = z.input<typeof alertEditSchema>;
