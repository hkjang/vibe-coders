/** API generation consumed by the shared client; independent of the release version. */
export const supportedApiVersion = "v1";

export function apiVersionMismatch(reported: string): boolean {
  return reported !== "" && reported !== "확인 불가" && reported !== supportedApiVersion;
}
