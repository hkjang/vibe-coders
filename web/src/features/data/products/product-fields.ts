import { z } from "zod";

export const productTabs = ["catalog", "requests", "candidates"] as const;
export type ProductTab = (typeof productTabs)[number];

export const productStatuses = ["draft", "published", "archived"] as const;
export type ProductStatus = (typeof productStatuses)[number];

export const productSourceTypes = ["saved_report", "metric", "golden_query", "custom"] as const;
export const productSensitivities = ["public", "internal", "restricted"] as const;

export const candidateWindows = ["7d", "30d", "90d"] as const;
export type CandidateWindow = (typeof candidateWindows)[number];

export const productStatusLabels: Record<string, string> = {
  draft: "초안",
  published: "게시됨",
  archived: "보관됨",
};

export const productSourceTypeLabels: Record<string, string> = {
  saved_report: "저장된 리포트",
  metric: "지표",
  golden_query: "골든 쿼리",
  custom: "직접 정의",
};

export const productSensitivityLabels: Record<string, string> = {
  public: "공개",
  internal: "내부용",
  restricted: "제한",
};

export const candidateWindowLabels: Record<CandidateWindow, string> = {
  "7d": "최근 7일",
  "30d": "최근 30일",
  "90d": "최근 90일",
};

export const requestStatusLabels: Record<string, string> = {
  pending: "대기",
  approved: "승인",
  denied: "거절",
};

export const productFormSchema = z.object({
  id: z.string(),
  product_key: z
    .string()
    .trim()
    .min(1, "상품 키를 입력하세요.")
    .regex(/^[A-Za-z0-9._-]+$/u, "영문, 숫자, . _ - 만 사용할 수 있습니다."),
  name_ko: z.string().trim().min(1, "상품 이름을 입력하세요."),
  description: z.string().trim(),
  source_type: z.enum(productSourceTypes),
  source_ref: z.string().trim(),
  owner: z.string().trim(),
  allowed_teams: z.string().trim(),
  sensitivity: z.enum(productSensitivities),
  status: z.enum(productStatuses),
});

export type ProductFormValues = z.infer<typeof productFormSchema>;

export const emptyProductForm: ProductFormValues = {
  id: "",
  product_key: "",
  name_ko: "",
  description: "",
  source_type: "custom",
  source_ref: "",
  owner: "",
  allowed_teams: "",
  sensitivity: "internal",
  status: "draft",
};

/** Splits the comma-separated team input into the array the server expects. */
export function parseTeams(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
