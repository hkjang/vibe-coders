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

export const defaultCredentialPrefixes = ["vc_sk_", "vc_sa_"] as const;

const maxSecretCandidateLength = 16_384;
const maxDecodePasses = 8;
const basicCredentialPattern = /(?:^|[^a-z0-9])basic(?:\s|\+)+([a-z0-9+/]{4,}={0,2})/giu;
const vendorCredentialPatterns = [
  /(?:^|[^A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{20,}(?=$|[^A-Za-z0-9])/u,
  /(?:^|[^A-Za-z0-9])github_pat_[A-Za-z0-9_]{20,}(?=$|[^A-Za-z0-9_])/u,
  /(?:^|[^A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?=$|[^A-Za-z0-9])/u,
  /(?:^|[^A-Za-z0-9])(?:xox[abprs]|xapp|xwfp)-[A-Za-z0-9-]{10,}(?=$|[^A-Za-z0-9-])/u,
  /(?:^|[^A-Za-z0-9])xoxe(?:\.[A-Za-z0-9.-]{8,}|-[A-Za-z0-9-]{8,})(?=$|[^A-Za-z0-9.-])/u,
  /(?:^|[^A-Za-z0-9])AIza[0-9A-Za-z_-]{35}(?=$|[^A-Za-z0-9_-])/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
] as const;

interface DecodedCandidate {
  exceededLimit: boolean;
  value: string;
  candidates: readonly string[];
}

function decoded(value: string): DecodedCandidate {
  if (value.length > maxSecretCandidateLength) return { exceededLimit: true, value: "", candidates: [] };
  let current = value;
  const candidates = [value];
  for (let attempt = 0; attempt < maxDecodePasses; attempt += 1) {
    if (!/%[\da-f]{2}/i.test(current)) return { exceededLimit: false, value: current, candidates };
    try {
      const next = decodeURIComponent(current);
      if (next === current) return { exceededLimit: false, value: current, candidates };
      current = next;
    } catch {
      try {
        current = decodeURIComponent(current.replace(/%(?![\da-f]{2})/gi, "%25"));
      } catch {
        return { exceededLimit: /%[\da-f]{2}/i.test(current), value: current, candidates };
      }
    }
    candidates.push(current);
  }
  return { exceededLimit: /%[\da-f]{2}/i.test(current), value: current, candidates };
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

function hasGeneratedCredentialSuffix(value: string): boolean {
  let length = 0;
  while (length < value.length && /[A-Za-z0-9_-]/u.test(value[length] ?? "")) length += 1;
  return length >= 32;
}

function containsBasicCredential(value: string): boolean {
  for (const match of value.matchAll(basicCredentialPattern)) {
    const encoded = match[1] ?? "";
    if (encoded.length > 8_192) return true;
    try {
      const binary = globalThis.atob(encoded);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      if (bytes.includes(58) && !bytes.some((byte) => byte <= 31 || byte === 127)) {
        return true;
      }
    } catch {
      // Ordinary prose following the word "Basic" is not a credential unless
      // it decodes to a valid user:password payload.
    }
  }
  return false;
}

function candidatesContainConfiguredCredential(
  candidates: readonly string[],
  credentialPrefixes: readonly string[],
): boolean {
  // Prefixes are literal configuration values, not URL-encoded strings. Inspect
  // each bounded decoding layer so a prefix such as "%41_" is not lost as "A_".
  for (const prefix of new Set(credentialPrefixes)) {
    if (prefix === "") continue;
    if (prefix.length > maxSecretCandidateLength) return true;
    for (const candidate of candidates) {
      let searchFrom = 0;
      while (searchFrom <= candidate.length) {
        const start = candidate.indexOf(prefix, searchFrom);
        if (start < 0) break;
        if (hasGeneratedCredentialSuffix(candidate.slice(start + prefix.length))) return true;
        searchFrom = start + 1;
      }
    }
  }
  return false;
}

export function containsConfiguredCredential(value: string, credentialPrefixes: readonly string[]): boolean {
  const result = decoded(value.trim());
  return result.exceededLimit || candidatesContainConfiguredCredential(result.candidates, credentialPrefixes);
}

export function containsPotentialSecret(
  value: string,
  credentialPrefixes: readonly string[] = defaultCredentialPrefixes,
): boolean {
  const decodedCandidate = decoded(value.trim());
  if (decodedCandidate.exceededLimit) return true;
  const candidate = decodedCandidate.value;
  if (candidate === "") return false;

  if (candidatesContainConfiguredCredential(decodedCandidate.candidates, credentialPrefixes)) return true;
  if (containsBasicCredential(candidate)) return true;
  if (vendorCredentialPatterns.some((pattern) => pattern.test(candidate))) return true;

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
