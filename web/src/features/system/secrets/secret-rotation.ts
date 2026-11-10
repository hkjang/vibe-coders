import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export const minimumSecretLength = 16;
export const confirmationPhrase = "비밀키 교체";

const generatedSecretBytes = 32;

/** 256 bits from the browser's CSPRNG, hex-encoded so it survives environment files. */
export function generateGatewaySecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(generatedSecretBytes));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The first problem with the entered keys; mirrors the server's own trim and length checks. */
export function secretDraftError(secret: string, repeated: string): string | undefined {
  const trimmed = secret.trim();
  if (trimmed === "") return "새 비밀키를 입력하세요.";
  if (trimmed.length < minimumSecretLength) return `새 비밀키는 ${minimumSecretLength}자 이상이어야 합니다.`;
  if (repeated === "") return "저장해 둔 새 비밀키를 한 번 더 입력하세요.";
  if (repeated.trim() !== trimmed) return "두 입력이 서로 다릅니다. 저장해 둔 값을 다시 확인하세요.";
  return undefined;
}

const rejectionMessages: Readonly<Record<string, string>> = {
  weak_secret: `새 비밀키는 ${minimumSecretLength}자 이상이어야 합니다.`,
  missing_field: "새 비밀키를 입력하세요.",
  invalid_body: "요청 형식이 올바르지 않습니다. 화면을 새로고침한 뒤 다시 시도하세요.",
  dev_secret_rejected: "개발용 기본값은 비밀키로 쓸 수 없습니다. 다른 값을 입력하세요.",
  rotation_in_progress: "이미 비밀키 교체가 진행 중입니다. 끝난 뒤 결과를 확인하세요.",
};

/**
 * Whether the server definitely refused before changing anything. Every other failure,
 * including a lost connection or a 5xx, may have committed: the new key might already be in
 * force, so it is reported as unknown and is never retried automatically.
 */
export function rotationRefused(error: unknown): boolean {
  if (!isAppError(error)) return false;
  if (error.kind === "auth" || error.kind === "permission") return true;
  return error.kind === "http" && error.status !== undefined && error.status >= 400 && error.status < 500;
}

export function rotationRefusalMessage(error: unknown, fallback: string): string {
  const message = isAppError(error) && error.code ? rejectionMessages[error.code] : undefined;
  return message ?? safeAppErrorMessage(error, fallback);
}

const storeLabels: Readonly<Record<string, string>> = {
  provider_configs: "공급자 API 키",
  mcp_upstreams: "MCP 인증값",
  text2sql_exec_connections: "Text2SQL 연결 문자열",
  admin_settings: "비밀 관리자 설정",
  sso_provider_config: "SSO 클라이언트 비밀값",
};

export const rotationStoreLabel = (store: string): string => storeLabels[store] ?? store;
export const rotationStores = Object.keys(storeLabels);
