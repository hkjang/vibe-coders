import { z } from "zod";

export const providerConnectionSchema = z
  .strictObject({
    outcome: z.enum([
      "catalog_available",
      "authentication_rejected",
      "redirect_blocked",
      "upstream_rejected",
      "invalid_response",
      "response_too_large",
      "model_limit_exceeded",
      "timeout",
      "connection_failed",
      "cancelled",
    ]),
    upstream_status: z.number().int().min(100).max(599).nullable(),
    duration_ms: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    timeout_ms: z.number().int().min(1).max(10000),
    model_count: z.number().int().nonnegative().max(10000).nullable(),
  })
  .refine(
    (value) =>
      value.outcome === "catalog_available" ? value.model_count !== null : value.model_count === null,
    "결과와 모델 수가 일치하지 않습니다.",
  )
  .refine((value) => {
    if (value.outcome === "catalog_available")
      return value.upstream_status !== null && value.upstream_status >= 200 && value.upstream_status < 300;
    if (value.outcome === "authentication_rejected")
      return value.upstream_status === 401 || value.upstream_status === 403;
    if (value.outcome === "redirect_blocked")
      return value.upstream_status !== null && value.upstream_status >= 300 && value.upstream_status < 400;
    return true;
  }, "결과와 공급자 HTTP 상태가 일치하지 않습니다.");

export type ProviderConnectionResult = z.infer<typeof providerConnectionSchema>;
export type ProviderConnectionBody = (
  | { readonly name: string; readonly provider_ref?: never }
  | { readonly name?: never; readonly provider_ref: string }
) & {
  readonly base_url: string;
  readonly timeout_ms?: number;
} & (
    | { readonly credential_mode: "draft"; readonly api_key: string }
    | { readonly credential_mode: "stored" | "none"; readonly api_key?: never }
  );
