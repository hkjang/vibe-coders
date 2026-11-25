import type {
  DLPAction,
  DLPCatalogProfile,
  DLPCheck,
  DLPConfidence,
  DLPConfig,
  DLPCustomProfile,
  DLPIssue,
  DLPPolicy,
} from "@/shared/api/domains/security-dlp";

export const dlpTabIds = ["overview", "policies", "profiles", "test", "events"] as const;
export type DLPTabId = (typeof dlpTabIds)[number];

export const dlpTabLabels: Readonly<Record<DLPTabId, string>> = {
  overview: "개요",
  policies: "정책",
  profiles: "프로필",
  test: "테스트 스캔",
  events: "탐지 이벤트",
};

export const actionLabels: Readonly<Record<DLPAction, string>> = {
  FLAG: "기록",
  MASK: "마스킹",
  BLOCK: "차단",
};

export const actionDescriptions: Readonly<Record<DLPAction, string>> = {
  FLAG: "요청과 응답은 그대로 두고 탐지 사실만 기록합니다. 새 정책은 여기서 시작해 오탐을 확인하세요.",
  MASK: "찾은 값을 [REDACTED_…] 표시로 바꿔 보냅니다. 요청은 공급자가, 응답은 클라이언트가 원래 값을 보지 못합니다.",
  BLOCK: "요청이나 응답 전체를 거부하고 400(dlp_request_blocked / dlp_response_blocked)을 돌려줍니다.",
};

export const actionTones: Readonly<Record<DLPAction, "info" | "warning" | "danger">> = {
  FLAG: "info",
  MASK: "warning",
  BLOCK: "danger",
};

export const checkLabels: Readonly<Record<DLPCheck, string>> = {
  REQUEST: "요청",
  RESPONSE: "응답",
};

export const confidenceLabels: Readonly<Record<DLPConfidence | "none", string>> = {
  none: "문맥 필요",
  low: "낮음",
  medium: "보통",
  high: "높음",
};

export const idPattern = /^[a-z0-9][a-z0-9_.-]{0,62}$/u;
export const idHint = "영문 소문자·숫자로 시작하고 소문자·숫자·_ . - 만 씁니다(최대 63자).";

/** A stable id from a display name, or "" when the name has nothing usable. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^[^a-z0-9]+|-+$/gu, "")
    .replace(/-{2,}/gu, "-")
    .slice(0, 63);
}

/** The first id built from base that the taken set does not hold yet. */
export function uniqueId(base: string, taken: ReadonlySet<string>, fallback: string): string {
  const root = idPattern.test(base) ? base : fallback;
  if (!taken.has(root)) return root;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${root.slice(0, 58)}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${root.slice(0, 50)}-${Date.now().toString(36)}`;
}

/** Splits a comma or newline separated list, trimmed, without blanks or repeats. */
export function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export interface ProfileOption {
  id: string;
  name: string;
  custom: boolean;
}

/** Every profile a policy may name: the predefined ones, then the custom ones. */
export function profileOptions(catalog: readonly DLPCatalogProfile[], config: DLPConfig): ProfileOption[] {
  return [
    ...catalog.map((profile) => ({ id: profile.id, name: profile.name, custom: false })),
    ...config.custom_profiles.map((profile) => ({ id: profile.id, name: profile.name, custom: true })),
  ];
}

export function profileName(id: string, catalog: readonly DLPCatalogProfile[], config?: DLPConfig): string {
  const reasons: Readonly<Record<string, string>> = {
    "scan-limit": "검사 상한",
    uninspectable: "읽을 수 없는 응답 형식",
    "inspection-error": "검사 오류",
  };
  if (reasons[id]) return reasons[id];
  return (
    catalog.find((profile) => profile.id === id)?.name ??
    config?.custom_profiles.find((profile) => profile.id === id)?.name ??
    id
  );
}

export function entryName(id: string, catalog: readonly DLPCatalogProfile[], config?: DLPConfig): string {
  for (const profile of catalog) {
    const entry = profile.entries.find((item) => item.id === id);
    if (entry) return entry.name;
  }
  const [profileId, entryId] = id.split("/", 2);
  const custom = config?.custom_profiles.find((profile) => profile.id === profileId);
  return custom?.entries.find((entry) => entry.id === entryId)?.name ?? id;
}

/**
 * Deterministic serialization for dirty checks: the server sorts checks and trims
 * lists, so compare what will be saved, not object identity.
 */
export function configFingerprint(config: DLPConfig): string {
  return JSON.stringify(config, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
      );
    }
    return value;
  });
}

/** The strongest action among enabled policies, per side. */
export function strongestActions(policies: readonly DLPPolicy[]): Record<DLPCheck, DLPAction | ""> {
  const rank: Record<DLPAction, number> = { FLAG: 1, MASK: 2, BLOCK: 3 };
  const out: Record<DLPCheck, DLPAction | ""> = { REQUEST: "", RESPONSE: "" };
  for (const policy of policies) {
    if (!policy.enabled) continue;
    for (const check of policy.check) {
      const current = out[check];
      if (current === "" || rank[policy.action] > rank[current]) out[check] = policy.action;
    }
  }
  return out;
}

/** Readiness notes for the overview: what an operator should look at next. */
export function readinessNotes(config: DLPConfig): { tone: "info" | "warning"; text: string }[] {
  const notes: { tone: "info" | "warning"; text: string }[] = [];
  const enabled = config.policies.filter((policy) => policy.enabled);
  if (config.enabled && enabled.length === 0) {
    notes.push({ tone: "warning", text: "DLP가 켜져 있지만 켜진 정책이 없어 아무것도 검사하지 않습니다." });
  }
  if (!config.enabled && enabled.length > 0) {
    notes.push({
      tone: "info",
      text: `켜진 정책 ${enabled.length}개가 있지만 DLP가 꺼져 있습니다. 테스트 스캔으로 결과를 확인한 뒤 켜세요.`,
    });
  }
  if (enabled.some((policy) => policy.check.includes("RESPONSE"))) {
    notes.push({
      tone: "info",
      text: "응답 검사 정책이 있어 스트리밍 응답은 끝까지 받은 뒤 검사하고 전달합니다. 첫 토큰이 늦어지며, 10초가 넘으면 연결이 끊기지 않도록 유지 신호를 보냅니다.",
    });
  }
  if (config.oversize === "allow") {
    notes.push({
      tone: "info",
      text: `검사 상한(${formatBytes(config.max_scan_bytes)})을 넘는 부분은 검사하지 않고 통과시킵니다. 엄격하게 운영하려면 상한 초과를 차단으로 바꾸세요.`,
    });
  }
  return notes;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1 << 20) return `${Number((bytes / (1 << 20)).toFixed(1))}MiB`;
  if (bytes >= 1024) return `${Number((bytes / 1024).toFixed(1))}KiB`;
  return `${bytes}B`;
}

export type IssueTab = Exclude<DLPTabId, "test" | "events">;

/** Which tab holds the field an issue path points at. */
export function issueTab(issue: DLPIssue): IssueTab {
  if (issue.path.startsWith("policies")) return "policies";
  if (issue.path.startsWith("profiles") || issue.path.startsWith("custom_profiles")) return "profiles";
  return "overview";
}

/** A readable place for an issue path such as policies[2].profiles. */
export function issueLocation(issue: DLPIssue, config: DLPConfig): string {
  const policy = /^policies\[(\d+)\]/u.exec(issue.path);
  if (policy) {
    const item = config.policies[Number(policy[1])];
    return `정책 ${item?.name || item?.id || Number(policy[1]) + 1}`;
  }
  const custom = /^custom_profiles\[(\d+)\](?:\.entries\[(\d+)\])?/u.exec(issue.path);
  if (custom) {
    const profile = config.custom_profiles[Number(custom[1])];
    const label = `사용자 프로필 ${profile?.name || profile?.id || Number(custom[1]) + 1}`;
    if (custom[2] !== undefined) {
      const entry = profile?.entries[Number(custom[2])];
      return `${label} · 항목 ${entry?.name || entry?.id || Number(custom[2]) + 1}`;
    }
    return label;
  }
  if (issue.path.startsWith("profiles.")) return `기본 프로필 ${issue.path.split(".")[1] ?? ""}`;
  const fields: Record<string, string> = {
    evidence: "증거 보관",
    max_scan_bytes: "검사 상한",
    oversize: "상한 초과 처리",
    policies: "정책",
    custom_profiles: "사용자 프로필",
  };
  return fields[issue.path] ?? issue.path;
}

export function newPolicy(taken: ReadonlySet<string>): DLPPolicy {
  return {
    id: uniqueId("policy", taken, "policy"),
    name: "",
    enabled: true,
    action: "FLAG",
    profiles: [],
    check: ["REQUEST"],
    teams: [],
    api_keys: [],
    note: "",
  };
}

export function newCustomProfile(taken: ReadonlySet<string>): DLPCustomProfile {
  return {
    id: uniqueId("custom", taken, "custom"),
    name: "",
    description: "",
    min_confidence: "low",
    min_matches: 1,
    entries: [
      {
        id: "keyword",
        name: "",
        type: "keywords",
        keywords: [],
        case_sensitive: false,
        confidence: "medium",
        context: [],
        mask: "",
      },
    ],
  };
}

/** Adds the recommended policies that the draft does not already have, by id. */
export function withRecommended(config: DLPConfig, recommended: readonly DLPPolicy[]): DLPConfig {
  const have = new Set(config.policies.map((policy) => policy.id));
  return { ...config, policies: [...config.policies, ...recommended.filter((p) => !have.has(p.id))] };
}

/** Policies that name a profile; removing the profile must not leave them dangling. */
export function policiesUsing(config: DLPConfig, profileId: string): DLPPolicy[] {
  return config.policies.filter((policy) => policy.profiles.includes(profileId));
}

export interface HighlightPart {
  text: string;
  match?: { entry: string; profile: string; confidence: string };
}

/**
 * Splits text at match offsets (UTF-8 bytes from the server) into plain and marked
 * parts. Overlapping matches are merged into the earlier one.
 */
export function highlightParts(
  text: string,
  matches: readonly {
    start: number;
    end: number;
    entry_name: string;
    profile_id: string;
    confidence: string;
  }[],
): HighlightPart[] {
  const bytes = new TextEncoder().encode(text);
  const decoder = new TextDecoder();
  const sorted = [...matches]
    .filter((m) => m.start >= 0 && m.end <= bytes.length && m.end > m.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (const m of sorted) {
    if (m.start < cursor) continue;
    if (m.start > cursor) parts.push({ text: decoder.decode(bytes.slice(cursor, m.start)) });
    parts.push({
      text: decoder.decode(bytes.slice(m.start, m.end)),
      match: { entry: m.entry_name, profile: m.profile_id, confidence: m.confidence },
    });
    cursor = m.end;
  }
  if (cursor < bytes.length) parts.push({ text: decoder.decode(bytes.slice(cursor)) });
  return parts;
}

/** Synthetic samples for the test scan: none of these are real people or accounts. */
export const dlpSamples: readonly { id: string; label: string; text: string }[] = [
  {
    id: "customer",
    label: "고객 상담 기록",
    text: "고객 김민수(생년월일 1990-01-01) 주민번호 900101-1234561, 연락처 010-1234-5678, 메일 kim.minsu@example.com 입니다. 주소는 서울특별시 중구 세종대로 110 입니다.",
  },
  {
    id: "payment",
    label: "결제 문의",
    text: "결제가 안 됩니다. 카드번호 4111 1111 1111 1111, 환불 계좌는 국민은행 계좌 123456-78-901234 로 부탁드립니다.",
  },
  {
    id: "credentials",
    label: "코드와 키",
    text: 'const client = new OpenAI({ apiKey: "sk-proj-EXAMPLEexample1234567890abcd" });\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\npostgres://app:s3cret@db.internal:5432/orders',
  },
  {
    id: "health",
    label: "의료 정보",
    text: "환자 진료기록번호 MRN 20240117 의 진단코드는 E11.9 이며, 건강보험증 번호 1-2345678901 로 청구합니다.",
  },
];

/** UTF-8 length, the unit of the server's scan limit. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * What a save would change, in words an operator can check before saving:
 * the switch, each policy and profile by name, and the scan settings.
 */
export function changeSummary(
  base: DLPConfig,
  draft: DLPConfig,
  catalog: readonly DLPCatalogProfile[] = [],
): string[] {
  const out: string[] = [];
  if (base.enabled !== draft.enabled) out.push(draft.enabled ? "DLP 켜기" : "DLP 끄기");
  const label = (policy: DLPPolicy): string => policy.name || policy.id;
  const before = new Map(base.policies.map((policy) => [policy.id, policy]));
  const after = new Map(draft.policies.map((policy) => [policy.id, policy]));
  for (const policy of draft.policies) {
    const old = before.get(policy.id);
    if (!old) out.push(`정책 추가: ${label(policy)}`);
    else if (
      configFingerprint({ ...base, policies: [old] }) !== configFingerprint({ ...base, policies: [policy] })
    ) {
      if (
        old.enabled !== policy.enabled &&
        configFingerprint({ ...base, policies: [{ ...old, enabled: policy.enabled }] }) ===
          configFingerprint({ ...base, policies: [policy] })
      ) {
        out.push(`정책 ${policy.enabled ? "켜기" : "끄기"}: ${label(policy)}`);
      } else {
        out.push(`정책 변경: ${label(policy)}`);
      }
    }
  }
  for (const policy of base.policies) {
    if (!after.has(policy.id)) out.push(`정책 삭제: ${label(policy)}`);
  }
  const profileIds = new Set([...Object.keys(base.profiles), ...Object.keys(draft.profiles)]);
  for (const id of profileIds) {
    if (JSON.stringify(base.profiles[id] ?? null) !== JSON.stringify(draft.profiles[id] ?? null)) {
      out.push(`프로필 조정: ${profileName(id, catalog, draft)}`);
    }
  }
  const customBefore = new Map(base.custom_profiles.map((profile) => [profile.id, profile]));
  const customAfter = new Map(draft.custom_profiles.map((profile) => [profile.id, profile]));
  for (const profile of draft.custom_profiles) {
    const old = customBefore.get(profile.id);
    if (!old) out.push(`사용자 프로필 추가: ${profile.name || profile.id}`);
    else if (JSON.stringify(old) !== JSON.stringify(profile))
      out.push(`사용자 프로필 변경: ${profile.name || profile.id}`);
  }
  for (const profile of base.custom_profiles) {
    if (!customAfter.has(profile.id)) out.push(`사용자 프로필 삭제: ${profile.name || profile.id}`);
  }
  if (base.evidence !== draft.evidence) {
    out.push(`증거 보관: ${draft.evidence === "hash_only" ? "지문만" : "부분 미리보기 + 지문"}`);
  }
  if (base.max_scan_bytes !== draft.max_scan_bytes) {
    out.push(`검사 상한: ${formatBytes(base.max_scan_bytes)} → ${formatBytes(draft.max_scan_bytes)}`);
  }
  if (base.oversize !== draft.oversize) {
    out.push(`상한 초과: ${draft.oversize === "block" ? "차단" : "끝부분만 검사하고 통과"}`);
  }
  return out;
}

/** Whether a catalog entry matches a search, by name, id, description or context word. */
export function entryMatches(
  entry: { id: string; name: string; description: string; context: readonly string[] },
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [entry.name, entry.id, entry.description, ...entry.context].some((value) =>
    value.toLowerCase().includes(needle),
  );
}
