import { z } from "zod";
import type { ModelContract } from "@/shared/api/domains/gateway.schemas";
import type { ModelContractWriteBody } from "@/shared/api/domains/gateway";

// Match the server's Go TrimSpace edge set, not JS trim (which additionally
// removes FEFF and misses NEL). Never normalize an existing stored identifier.
const goEdgeSpace = /^\p{White_Space}|\p{White_Space}$/u;
export const trimModelSpace = (value: string): string =>
  value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
const modelText = (maximum: number) => z.string().transform(trimModelSpace).pipe(z.string().max(maximum));
export const modelIdentityReason =
  "저장 대상을 정확히 확인할 수 없어 변경할 수 없습니다. 목록을 다시 조회하세요.";
export const modelPrecisionReason =
  "저장된 평균 지연 값을 브라우저에서 정확한 정수로 표현할 수 없어 수정할 수 없습니다.";
export function safeModelTarget(id: string, kind: "contract" | "deprecation"): boolean {
  if (!id) return false;
  try {
    encodeURIComponent(id);
  } catch {
    return false;
  }
  return kind === "contract"
    ? !goEdgeSpace.test(id)
    : !id.startsWith("/") && !id.endsWith("/") && id !== "." && id !== "..";
}
const optionalNumber = (label: string, integer = false) =>
  z
    .string()
    .trim()
    .refine(
      (value) =>
        value === "" ||
        (Number.isFinite(Number(value)) &&
          Number(value) >= 0 &&
          (!integer || Number.isSafeInteger(Number(value)))),
      `${label}은(는) 0 이상의 ${integer ? "안전한 정수" : "숫자"}여야 합니다.`,
    );
export const contractFields = [
  ["name", "이름"],
  ["task_type", "작업 유형"],
  ["min_quality_score", "최소 품질 점수"],
  ["min_golden_pass_rate", "최소 골든 통과율"],
  ["min_success_rate", "최소 성공률"],
  ["max_latency_ms", "최대 평균 지연(ms)"],
  ["max_avg_cost_krw", "최대 평균 비용(원)"],
  ["enabled", "계약 사용"],
] as const;
export const contractSchema = z.object({
  name: modelText(200).refine((value) => value !== "", "계약 이름을 입력하세요."),
  task_type: modelText(120).default(""),
  min_quality_score: optionalNumber("품질 점수"),
  min_golden_pass_rate: optionalNumber("골든 통과율"),
  min_success_rate: optionalNumber("성공률"),
  max_latency_ms: optionalNumber("평균 지연", true),
  max_avg_cost_krw: optionalNumber("평균 비용"),
  enabled: z.boolean().default(true),
});
export type ContractInput = z.input<typeof contractSchema>;
export type ContractOutput = z.output<typeof contractSchema>;
export function contractValues(row?: ModelContract): ContractInput {
  return {
    name: row?.name ?? "",
    task_type: row?.task_type ?? "",
    min_quality_score: String(row?.min_quality_score ?? ""),
    min_golden_pass_rate: String(row?.min_golden_pass_rate ?? ""),
    min_success_rate: String(row?.min_success_rate ?? ""),
    max_latency_ms: String(row?.max_latency_ms ?? ""),
    max_avg_cost_krw: String(row?.max_avg_cost_krw ?? ""),
    enabled: row?.enabled ?? true,
  };
}
export function contractBody(values: ContractOutput, id?: string): ModelContractWriteBody {
  return {
    ...(id !== undefined ? { id } : {}),
    name: values.name,
    task_type: values.task_type,
    min_quality_score: Number(values.min_quality_score || 0),
    min_golden_pass_rate: Number(values.min_golden_pass_rate || 0),
    min_success_rate: Number(values.min_success_rate || 0),
    max_latency_ms: Number(values.max_latency_ms || 0),
    max_avg_cost_krw: Number(values.max_avg_cost_krw || 0),
    enabled: values.enabled,
  };
}
export const deprecationSchema = z.object({
  model_glob: modelText(200).refine((value) => value !== "", "모델 패턴을 입력하세요."),
  replacement: modelText(200).default(""),
  sunset_date: z
    .string()
    .trim()
    .refine((value) => {
      if (value === "") return true;
      if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
      const date = new Date(`${value}T00:00:00Z`);
      return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
    }, "실제 날짜를 YYYY-MM-DD 형식으로 입력하세요.")
    .default(""),
  message: modelText(1000).default(""),
});
export type DeprecationInput = z.input<typeof deprecationSchema>;
export type DeprecationOutput = z.output<typeof deprecationSchema>;
