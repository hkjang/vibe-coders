import { z } from "zod";

import type { RedTeamProbeCase } from "@/shared/api/domains/redteam";

/** Pack select value that files the case under a new custom pack. */
export const newPackOption = "__new__";

export const probeCaseFormSchema = z.object({
  case_id: z.string(),
  pack: z.string(),
  pack_name: z.string().trim(),
  case_key: z.string().trim().min(1, "케이스 키를 입력하세요."),
  expected_policy: z.string(),
  evaluator_type: z.string(),
  severity: z.string(),
  target_types: z.string(),
  input_template: z.string().trim().min(1, "요청 프롬프트를 입력하세요."),
});

export type ProbeCaseFormValues = z.output<typeof probeCaseFormSchema>;

export function probeCaseDefaults(packId: string, existing?: RedTeamProbeCase): ProbeCaseFormValues {
  return {
    case_id: existing?.id ?? "",
    pack: packId === "" ? newPackOption : packId,
    pack_name: "",
    case_key: existing?.case_key ?? "",
    expected_policy: existing?.expected_policy || "refuse",
    evaluator_type: existing?.evaluator_type || "rule",
    severity: existing?.severity || "medium",
    target_types: (existing?.target_types ?? []).join(","),
    input_template: existing?.input_template ?? "",
  };
}
