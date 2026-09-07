import { z } from "zod";

import type { Skill, SkillWriteBody } from "@/shared/api/domains/agents.schemas";

export const skillStatuses = ["draft", "staging", "production", "deprecated"] as const;
export const skillRiskLevels = ["low", "medium", "high"] as const;

export const skillStatusLabels: Record<string, string> = {
  draft: "초안",
  staging: "스테이징",
  production: "프로덕션",
  deprecated: "지원 중단",
};

export const skillRiskLabels: Record<string, string> = {
  low: "낮음",
  medium: "보통",
  high: "높음",
};

export const skillStatusOptions = skillStatuses.map((status) => ({
  value: status,
  label: skillStatusLabels[status] ?? status,
}));

export const skillRiskOptions = skillRiskLevels.map((risk) => ({
  value: risk,
  label: skillRiskLabels[risk] ?? risk,
}));

export const skillStatusFilters = [{ value: "all", label: "전체 상태" }, ...skillStatusOptions];

/** Lifecycle moves the server accepts (`validSkillTransitions`). */
const skillTransitions: Record<string, readonly string[]> = {
  draft: ["staging", "deprecated"],
  staging: ["production", "draft", "deprecated"],
  production: ["staging", "deprecated"],
  deprecated: ["staging", "draft"],
};

export function allowedSkillTransitions(status: string | undefined): readonly string[] {
  return skillTransitions[status?.trim() || "draft"] ?? [];
}

export const skillFormSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Skill 이름을 입력하세요.")
      .regex(/^[a-z0-9][a-z0-9-]*$/u, "소문자, 숫자, 하이픈만 사용할 수 있습니다."),
    description: z.string(),
    version: z.string(),
    owner: z.string(),
    status: z.string(),
    risk_level: z.string(),
    allowed_models: z.string(),
    allowed_tools: z.string(),
    allowed_teams: z.string(),
    daily_limit: z.string(),
    instructions: z.string(),
  })
  .superRefine((values, ctx) => {
    if (values.daily_limit.trim() !== "" && !/^\d+$/u.test(values.daily_limit.trim())) {
      ctx.addIssue({ code: "custom", path: ["daily_limit"], message: "0 이상의 정수를 입력하세요." });
    }
  })
  .transform((values) => ({
    name: values.name.trim(),
    description: values.description.trim(),
    version: values.version.trim(),
    owner: values.owner.trim(),
    status: values.status,
    risk_level: values.risk_level,
    allowed_models: values.allowed_models.trim(),
    allowed_tools: values.allowed_tools.trim(),
    allowed_teams: values.allowed_teams.trim(),
    daily_limit: values.daily_limit.trim() === "" ? 0 : Number(values.daily_limit.trim()),
    instructions: values.instructions,
  }));

export type SkillFormInput = z.input<typeof skillFormSchema>;
export type SkillFormOutput = z.output<typeof skillFormSchema>;

export function skillFormDefaults(skill?: Skill): SkillFormInput {
  return {
    name: skill?.name ?? "",
    description: skill?.description ?? "",
    version: skill?.version ?? "",
    owner: skill?.owner ?? "",
    status: skill?.status ?? "draft",
    risk_level: skill?.risk_level ?? "low",
    allowed_models: skill?.allowed_models ?? "",
    allowed_tools: skill?.allowed_tools ?? "",
    allowed_teams: skill?.allowed_teams ?? "",
    daily_limit: skill?.daily_limit ? String(skill.daily_limit) : "",
    instructions: skill?.instructions ?? "",
  };
}

export function skillWriteBody(values: SkillFormOutput): SkillWriteBody {
  return { ...values };
}

export function matchesSkillQuery(skill: Skill, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [skill.name, skill.description, skill.owner, skill.allowed_teams].some((value) =>
    (value ?? "").toLowerCase().includes(needle),
  );
}

export function riskTone(risk: string | undefined): "danger" | "info" | "muted" | "success" | "warning" {
  switch (risk) {
    case "high":
      return "danger";
    case "medium":
      return "warning";
    case "low":
      return "success";
    default:
      return "muted";
  }
}

export function statusTone(status: string | undefined): "danger" | "info" | "muted" | "success" | "warning" {
  switch (status) {
    case "production":
      return "success";
    case "staging":
      return "info";
    case "deprecated":
      return "danger";
    default:
      return "muted";
  }
}

export function severityTone(
  severity: string | undefined,
): "danger" | "info" | "muted" | "success" | "warning" {
  switch (severity) {
    case "high":
      return "danger";
    case "medium":
      return "warning";
    case "low":
      return "info";
    default:
      return "success";
  }
}
