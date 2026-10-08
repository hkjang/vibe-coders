/** Match the existing server's strings.TrimSpace, including NEL but not FEFF. */
export function normalizeDomainDecisionRequestID(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}

/** A narrow UI/deep-link bound, not a change to the existing server's ID policy. */
export function domainDecisionRequestIDError(value: string): string | undefined {
  if (value !== normalizeDomainDecisionRequestID(value)) {
    return "요청 ID의 앞뒤 공백과 제어 문자를 제거하세요.";
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) return "요청 ID의 앞뒤 공백과 제어 문자를 제거하세요.";
    if (code >= 0xd800 && code <= 0xdfff) return "요청 ID에 올바르지 않은 유니코드 문자가 있습니다.";
  }
  if (new TextEncoder().encode(value).length > 512) return "요청 ID는 UTF-8 기준 512바이트 이하여야 합니다.";
  return undefined;
}
