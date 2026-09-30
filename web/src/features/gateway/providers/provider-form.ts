import { z } from "zod";

import type { ProviderCatalogRow } from "@/features/gateway/providers/provider-catalog";
import type { ProviderWriteBody } from "@/shared/api/domains/gateway";

export const numberText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0), {
      message: `${label}은(는) 0 이상의 숫자여야 합니다.`,
    })
    .refine((value) => value === "" || Number(value) <= max, {
      message: `${label}이(가) 허용 범위를 넘었습니다.`,
    });

const integerText = (label: string, max: number) =>
  numberText(label, max).refine((value) => value === "" || Number.isInteger(Number(value)), {
    message: `${label}은(는) 정수여야 합니다.`,
  });

export const providerFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "공급자 이름을 입력하세요.")
    .max(200)
    .refine((value) => !/[,\s]/u.test(value), "공급자 이름에는 공백과 쉼표를 넣을 수 없습니다."),
  base_url: z
    .string()
    .trim()
    .min(1, "기본 URL을 입력하세요.")
    .refine((value) => /^https?:\/\//u.test(value), "http 또는 https로 시작하는 URL이어야 합니다."),
  api_key: z.string().default(""),
  timeout_ms: integerText("제한 시간", 600_000),
  model_patterns: z.string().trim().max(2000).default(""),
  failover_group: z.string().trim().max(200).default(""),
  priority: integerText("우선순위", 100_000),
  enabled: z.boolean().default(true),
});

export type ProviderFormInput = z.input<typeof providerFormSchema>;
export type ProviderFormOutput = z.output<typeof providerFormSchema>;

export function providerWriteBody(values: ProviderFormOutput): ProviderWriteBody {
  return {
    name: values.name,
    base_url: values.base_url,
    // Blank preserves the stored secret. Review renders only keep/replace, never this value.
    api_key: values.api_key.trim() === "" ? undefined : values.api_key,
    timeout_ms: values.timeout_ms === "" ? undefined : Number(values.timeout_ms),
    model_patterns: values.model_patterns,
    failover_group: values.failover_group,
    priority: values.priority === "" ? undefined : Number(values.priority),
    enabled: values.enabled,
  };
}

export function providerFormValues(row?: ProviderCatalogRow): ProviderFormInput {
  return {
    name: row?.provider.name ?? "",
    base_url: row?.provider.base_url ?? "",
    api_key: "",
    timeout_ms: row ? String(row.provider.timeout_ms) : "",
    model_patterns: row?.provider.model_patterns ?? "",
    failover_group: row?.provider.failover_group ?? "",
    priority: row ? String(row.provider.priority) : "",
    enabled: row?.provider.enabled ?? true,
  };
}
