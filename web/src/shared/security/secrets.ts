const sensitiveCredentialTerms = [
  "authorization",
  "credential",
  "credentials",
  "password",
  "passwd",
  "secret",
  "signature",
  "token",
] as const;

const exactCredentialKeys = new Set([
  "accesskey",
  "accesstoken",
  "auth",
  "apikey",
  "authkey",
  "authtoken",
  "bearertoken",
  "clientsecret",
  "credentialid",
  "kcaccess",
  "kcrefresh",
  "privatekey",
  "refreshtoken",
  "secretkey",
  "sessionkey",
  "signatureversion",
  "subscriptionkey",
]);
const exactCredentialParts = new Set(["auth", "key", "sig"]);

export const secretSearchMessage =
  "인증정보로 보이는 검색어는 주소에 저장하지 않습니다. 비밀정보를 제거한 뒤 검색하세요.";

const maxSecretCandidateLength = 16_384;
const maxDecodePasses = 8;

interface DecodedCandidate {
  exceededLimit: boolean;
  value: string;
}

function decoded(value: string): DecodedCandidate {
  if (value.length > maxSecretCandidateLength) return { exceededLimit: true, value: "" };
  let current = value;
  for (let attempt = 0; attempt < maxDecodePasses; attempt += 1) {
    if (!/%[\da-f]{2}/i.test(current)) return { exceededLimit: false, value: current };
    try {
      const next = decodeURIComponent(current);
      if (next === current) return { exceededLimit: false, value: current };
      current = next;
    } catch {
      try {
        current = decodeURIComponent(current.replace(/%(?![\da-f]{2})/gi, "%25"));
      } catch {
        return { exceededLimit: /%[\da-f]{2}/i.test(current), value: current };
      }
    }
  }
  return { exceededLimit: /%[\da-f]{2}/i.test(current), value: current };
}

export function isSensitiveCredentialKey(key: string): boolean {
  const parts = key
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const compact = parts.join("");
  if (exactCredentialKeys.has(compact)) return true;
  if (parts.some((part) => exactCredentialParts.has(part))) return true;
  return parts.some((part) => sensitiveCredentialTerms.some((term) => part.includes(term)));
}

export function containsPotentialSecret(value: string): boolean {
  const decodedCandidate = decoded(value.trim());
  if (decodedCandidate.exceededLimit) return true;
  const candidate = decodedCandidate.value;
  if (candidate === "") return false;

  if (
    /\bbearer(?:\s|\+)+[^\s,;]+/i.test(candidate) ||
    /\bsk-(?:proj-|ant-|svcacct-)?[a-z0-9_-]{8,}\b/i.test(candidate) ||
    /(?:^|[^a-z0-9])vc_(?:sk|sa)_[a-z0-9_-]{8,}(?=$|[^a-z0-9_-])/i.test(candidate) ||
    /\beyJ[a-z0-9_-]{4,}\.[a-z0-9_-]{4,}\.[a-z0-9_-]{4,}\b/i.test(candidate) ||
    /(?:^|[?&#=;,\s/])[^\s/@:]+:[^\s/@]+@(?:\[[^\]]+\]|[^\s/:?#]+)(?::\d+)?(?:[/?#]|$)/i.test(candidate)
  ) {
    return true;
  }

  try {
    const url = new URL(candidate);
    if (url.username !== "" || url.password !== "") return true;
    if ([...url.searchParams.keys()].some(isSensitiveCredentialKey)) return true;
  } catch {
    // Search text is commonly not a URL; assignment scanning below still applies.
  }

  const assignments = candidate.matchAll(
    /(?=(?:^|[?&#;,=\s{])(?:["']?)([a-z0-9_.-]+)(?:["']?)\s*(?:=|:)\s*(?:["']?)([^\s,;&}"']+))/gi,
  );
  for (const assignment of assignments) {
    const key = assignment[1] ?? "";
    const assignedValue = assignment[2] ?? "";
    if (assignedValue !== "" && isSensitiveCredentialKey(key)) return true;
  }
  return false;
}
