import type {
  ProviderConnectionBody,
  ProviderConnectionResult,
} from "@/shared/api/domains/provider-connection.schemas";
import { isProviderRef } from "@/shared/api/provider-ref";
import type { ProviderCatalogRow } from "./provider-catalog";
import { providerFormSchema, redactedProviderURL, type ProviderFormInput } from "./provider-form";

export const connectionFields = ["name", "base_url", "api_key", "timeout_ms"] as const;
const connectionSchema = providerFormSchema.pick({
  name: true,
  base_url: true,
  api_key: true,
  timeout_ms: true,
});
export type ConnectionIssue = { field: (typeof connectionFields)[number]; message: string };

/** Builds only one outgoing body; callers never retain this in result or mutation state. */
export function providerConnectionInput(
  values: ProviderFormInput,
  row: ProviderCatalogRow | undefined,
  noKeyAcknowledged: boolean,
): { body: ProviderConnectionBody } | { issue: ConnectionIssue } {
  // Existing identities are opaque. Do not impose new-name rules on a saved legacy name.
  const parsed = connectionSchema.safeParse({ ...values, name: row ? "existing-provider" : values.name });
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = connectionFields.find((name) => name === first?.path[0]) ?? "base_url";
    return { issue: { field, message: first?.message ?? "연결 입력을 확인하세요." } };
  }
  const value = parsed.data;
  if (value.base_url === redactedProviderURL)
    return {
      issue: {
        field: "base_url",
        message: "숨겨진 주소는 검사할 수 없습니다. 새 주소와 새 API 키를 입력하세요.",
      },
    };
  if (row && !isProviderRef(row.identity))
    return {
      issue: { field: "base_url", message: "공급자 참조를 확인할 수 없습니다. 목록을 새로 조회하세요." },
    };
  const target = row ? { provider_ref: row.identity } : { name: value.name };
  const common = {
    ...target,
    base_url: value.base_url,
    ...(value.timeout_ms === "" ? {} : { timeout_ms: Number(value.timeout_ms) }),
  };
  if (value.api_key.trim() !== "") {
    if (new TextEncoder().encode(value.api_key).length > 8192)
      return { issue: { field: "api_key", message: "API 키는 8192바이트 이하여야 합니다." } };
    return { body: { ...common, credential_mode: "draft", api_key: value.api_key } };
  }
  if (row?.provider.api_key_configured) {
    if (value.base_url !== row.provider.base_url.trim())
      return {
        issue: {
          field: "api_key",
          message: "주소를 변경한 경우 새 API 키를 입력해야 연결을 확인할 수 있습니다.",
        },
      };
    return { body: { ...common, credential_mode: "stored" } };
  }
  if (!noKeyAcknowledged)
    return { issue: { field: "api_key", message: "API 키를 입력하거나 ‘API 키 없이 확인’에 동의하세요." } };
  return { body: { ...common, credential_mode: "none" } };
}

export const connectionOutcomeLabels: Record<ProviderConnectionResult["outcome"], string> = {
  catalog_available: "모델 목록 연결을 확인했습니다.",
  authentication_rejected: "공급자가 인증을 거부했습니다.",
  redirect_blocked: "다른 주소로의 이동을 차단했습니다.",
  upstream_rejected: "공급자가 요청을 거부했습니다.",
  invalid_response: "모델 목록 응답 형식을 확인할 수 없습니다.",
  response_too_large: "응답 크기가 검사 한도를 넘었습니다.",
  model_limit_exceeded: "모델 수가 검사 한도를 넘었습니다.",
  timeout: "연결 확인 시간이 초과되었습니다.",
  connection_failed: "공급자에 연결하지 못했습니다.",
  cancelled: "연결 확인이 취소되었습니다.",
};

export const connectionFailureLabels: Readonly<Record<string, string>> = {
  provider_already_exists: "같은 이름의 공급자가 이미 있습니다. 목록을 확인하고 수정 화면에서 검사하세요.",
  provider_destination_changed: "저장된 주소가 달라졌습니다. 편집을 닫고 최신 공급자 정보를 확인하세요.",
  stored_credential_unavailable: "저장된 API 키를 사용할 수 없습니다. 새 키를 입력하세요.",
  stored_credential_present:
    "저장된 API 키가 있습니다. 키 없이 확인할 수 없으므로 최신 공급자 정보를 확인하세요.",
  provider_not_found: "공급자를 찾을 수 없습니다. 목록을 새로 조회하세요.",
};
