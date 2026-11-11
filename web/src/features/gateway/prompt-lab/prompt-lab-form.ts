import { z } from "zod";
import type { TabItem } from "@/shared/components/ui/Tabs";
export const tabIds = ["experiments", "contracts", "rubrics"] as const;
export type PromptLabTabId = (typeof tabIds)[number];

export const tabs: ReadonlyArray<TabItem<PromptLabTabId>> = [
  { id: "experiments", label: "실험" },
  { id: "contracts", label: "출력 계약" },
  { id: "rubrics", label: "평가 기준" },
];

export const experimentSchema = z.object({
  title: z.string().trim().min(1, "실험 제목을 입력하세요.").max(200),
  description: z.string().trim().max(1000).default(""),
  team: z.string().trim().max(120).default(""),
});
export type ExperimentInput = z.input<typeof experimentSchema>;
export type ExperimentOutput = z.output<typeof experimentSchema>;

export const contractTypes = ["json", "json_schema", "markdown_table", "sql", "regex"] as const;
export const contractSchema = z.object({
  name: z.string().trim().min(1, "계약 이름을 입력하세요.").max(200),
  type: z.enum(contractTypes),
  schema_json: z.string().trim().max(20_000).default(""),
  strict: z.boolean().default(false),
});
export type ContractInput = z.input<typeof contractSchema>;
export type ContractOutput = z.output<typeof contractSchema>;

export const rubricSchema = z.object({
  name: z.string().trim().min(1, "평가 기준 이름을 입력하세요.").max(200),
  criteria_json: z
    .string()
    .trim()
    .max(20_000)
    .default("")
    .refine((value) => {
      if (value === "") return true;
      try {
        JSON.parse(value);
        return true;
      } catch {
        return false;
      }
    }, "올바른 JSON이 아닙니다."),
});
export type RubricInput = z.input<typeof rubricSchema>;
export type RubricOutput = z.output<typeof rubricSchema>;

export const testCaseSchema = z.object({
  name: z.string().trim().min(1, "테스트 케이스 이름을 입력하세요.").max(200),
  models: z.string().trim().max(500).default(""),
  contract_id: z.string().trim().max(120).default(""),
  rubric_id: z.string().trim().max(120).default(""),
  system: z.string().max(20_000).default(""),
  user: z.string().trim().min(1, "사용자 프롬프트를 입력하세요.").max(20_000),
});
export type TestCaseInput = z.input<typeof testCaseSchema>;
export type TestCaseOutput = z.output<typeof testCaseSchema>;

export const contractTypeLabels: Record<(typeof contractTypes)[number], string> = {
  json: "JSON",
  json_schema: "JSON 스키마",
  markdown_table: "마크다운 표",
  sql: "읽기 전용 SQL",
  regex: "정규식",
};
