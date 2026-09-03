const ssoFailureMessages = {
  access_denied: "SSO 로그인이 취소되었거나 접근이 거부되었습니다.",
  browser_binding_failed:
    "SSO 로그인을 시작한 브라우저를 확인하지 못했습니다. 같은 브라우저에서 다시 시도하세요.",
  discovery_failed: "SSO 인증 서버 정보를 확인하지 못했습니다. 관리자에게 문의하세요.",
  id_token_verification_failed:
    "SSO 사용자 토큰을 확인하지 못했습니다. 로그인을 다시 시작하거나 관리자에게 문의하세요.",
  identity_provider_error: "SSO 인증 제공자에서 로그인을 완료하지 못했습니다. 잠시 후 다시 시도하세요.",
  interaction_required: "SSO 인증을 계속하려면 추가 확인이 필요합니다. 로그인을 다시 시작하세요.",
  invalid_or_expired_state: "SSO 로그인 상태가 만료되었거나 올바르지 않습니다. 로그인을 다시 시작하세요.",
  login_required: "SSO 로그인이 필요합니다. 로그인을 다시 시작하세요.",
  missing_authorization_code: "SSO 인증 코드가 전달되지 않았습니다. 로그인을 다시 시작하세요.",
  session_exchange_generation_failed: "SSO 세션을 준비하지 못했습니다. 잠시 후 다시 시도하세요.",
  session_exchange_initialization_failed: "SSO 세션을 준비하지 못했습니다. 잠시 후 다시 시도하세요.",
  sso_callback_failed: "SSO 로그인을 완료하지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요.",
  sso_exchange_failed: "SSO 세션을 교환하지 못했습니다. 로그인을 다시 시작하세요.",
  sso_session_failed: "SSO 세션을 준비하지 못했습니다. 잠시 후 다시 시도하세요.",
  sso_session_link_failed: "SSO 세션을 연결하지 못했습니다. 잠시 후 다시 시도하세요.",
  temporarily_unavailable: "SSO 인증 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도하세요.",
  token_exchange_failed: "SSO 인증 토큰을 발급받지 못했습니다. 잠시 후 다시 시도하세요.",
  unsupported_sso_callback: "지원하지 않는 SSO 응답입니다. 로그인을 다시 시작하세요.",
  user_provisioning_failed:
    "SSO 사용자 정보를 준비하지 못했습니다. 잠시 후 다시 시도하거나 관리자에게 문의하세요.",
} as const;

type SsoFailureCode = keyof typeof ssoFailureMessages;

function isSsoFailureCode(code: string | undefined): code is SsoFailureCode {
  return code !== undefined && Object.hasOwn(ssoFailureMessages, code);
}

export function normalizeSsoFailureCode(
  code: string | undefined,
  fallback: SsoFailureCode = "sso_callback_failed",
): SsoFailureCode {
  return isSsoFailureCode(code) ? code : fallback;
}

export function formatSsoFailure(code: string | undefined): string {
  const safeCode = normalizeSsoFailureCode(code);
  return `${ssoFailureMessages[safeCode]} (진단 코드: ${safeCode})`;
}
