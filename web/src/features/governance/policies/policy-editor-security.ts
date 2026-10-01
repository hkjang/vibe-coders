import { containsPotentialSecret, isSensitiveCredentialKey } from "@/shared/security/secrets";

export const protectedText = "민감정보가 포함될 수 있어 표시하지 않습니다.";
// Actual server policy vocabulary, not arbitrary credential-key exceptions.
const policyKeys = new Set(["contains_secret", "secret_type", "secret_action"]);
export function protectedJson(value: unknown, prefixes: readonly string[]): boolean {
  if (typeof value === "string") return containsPotentialSecret(value, prefixes);
  if (Array.isArray(value)) return value.some((item) => protectedJson(item, prefixes));
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([key, item]) =>
        containsPotentialSecret(key, prefixes) ||
        (!policyKeys.has(key) && isSensitiveCredentialKey(key)) ||
        protectedJson(item, prefixes),
    );
  return false;
}
export function editorText(value: string | undefined, prefixes: readonly string[]): string {
  return value && containsPotentialSecret(value, prefixes) ? protectedText : value || "(빈 값)";
}
export function editorJson(value: unknown, prefixes: readonly string[]): string {
  return protectedJson(value, prefixes)
    ? protectedText
    : (JSON.stringify(value, null, 2) ?? "확인할 수 없음");
}
// Go strings.TrimSpace's White_Space set: includes NEL, excludes FEFF.
export function goTrim(value: string): string {
  return value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
}
export function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${fingerprint((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
