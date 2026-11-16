import { z } from "zod";
import type { ReviewedProfile } from "@/shared/api/domains/text2sql-profile-review";

const bounded = z
  .string()
  .trim()
  .refine((value) => new TextEncoder().encode(value).length <= 512, "512바이트 이내로 입력하세요.");
export const profileFormSchema = z.object({
  virtual_model: bounded
    .transform((value) => value.toLowerCase())
    .refine((value) => value.startsWith("vibe/text2sql"), "가상 모델명은 vibe/text2sql 로 시작해야 합니다."),
  mode: z.enum(["preview", "execute"]),
  upstream_model: bounded,
  summary_model: bounded,
  schema_name: bounded,
  exec_connection_id: bounded,
  enabled: z.boolean(),
  reason: z
    .string()
    .trim()
    .min(1, "변경 사유를 입력하세요.")
    .refine((value) => [...value].length <= 500, "500자 이내로 입력하세요."),
});
export type ProfileFormValues = z.infer<typeof profileFormSchema>;
export const profileFields = [
  ["virtual_model", "가상 모델"],
  ["mode", "모드"],
  ["upstream_model", "업스트림 모델"],
  ["summary_model", "요약 모델"],
  ["schema_name", "스키마명"],
  ["exec_connection_id", "실행 DB 연결"],
  ["enabled", "프로필 적용"],
] as const;
export const profileDefaults = (profile?: ReviewedProfile | null): ProfileFormValues => ({
  virtual_model: profile?.virtual_model ?? "",
  mode: profile?.mode ?? "preview",
  upstream_model: profile?.upstream_model ?? "",
  summary_model: profile?.summary_model ?? "",
  schema_name: profile?.schema_name ?? "",
  exec_connection_id: profile?.exec_connection_id ?? "",
  enabled: profile?.enabled ?? true,
  reason: "",
});
export const profileValueLabel = (
  key: (typeof profileFields)[number][0],
  value: string | boolean,
): string => {
  if (key === "enabled") return value ? "적용" : "미적용 · 서버 기본 설정 사용";
  if (key === "mode") return value === "execute" ? "실행 (SQL 조회까지)" : "미리보기 (SQL 생성만)";
  if (key === "exec_connection_id" && (!value || value === "default")) return "기본 DB (서버 설정)";
  return String(value || "서버 기본 설정");
};
