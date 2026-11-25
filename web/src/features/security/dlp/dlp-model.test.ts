import { describe, expect, it } from "vitest";

import type { DLPCatalogProfile, DLPConfig, DLPPolicy } from "@/shared/api/domains/security-dlp";

import {
  changeSummary,
  configFingerprint,
  entryMatches,
  utf8Bytes,
  dlpSamples,
  entryName,
  formatBytes,
  highlightParts,
  idPattern,
  issueLocation,
  issueTab,
  newCustomProfile,
  newPolicy,
  policiesUsing,
  profileName,
  readinessNotes,
  slugify,
  splitList,
  strongestActions,
  uniqueId,
  withRecommended,
} from "./dlp-model";

function policy(overrides: Partial<DLPPolicy> & Pick<DLPPolicy, "id">): DLPPolicy {
  return {
    name: "",
    enabled: true,
    action: "FLAG",
    profiles: ["pii"],
    check: ["REQUEST"],
    teams: [],
    api_keys: [],
    note: "",
    ...overrides,
  };
}

function config(overrides: Partial<DLPConfig> = {}): DLPConfig {
  return {
    enabled: true,
    evidence: "partial",
    max_scan_bytes: 262144,
    oversize: "allow",
    profiles: {},
    custom_profiles: [],
    policies: [],
    ...overrides,
  };
}

const catalog: DLPCatalogProfile[] = [
  {
    id: "pii",
    name: "개인 식별 정보",
    description: "",
    default_min_confidence: "medium",
    default_min_matches: 1,
    record_distinct: 0,
    record_window: 0,
    entries: [
      {
        id: "email",
        name: "이메일 주소",
        description: "",
        base_confidence: "high",
        requires_context: false,
        context: [],
        mask: "[REDACTED_EMAIL]",
        example: "kim.minsu@example.com",
      },
    ],
  },
];

describe("ids", () => {
  it("slugifies names and falls back when nothing usable is left", () => {
    expect(slugify("Mask Credentials!")).toBe("mask-credentials");
    expect(slugify("  --Customer IDs--  ")).toBe("customer-ids");
    expect(slugify("고객 정보")).toBe("");
    expect(idPattern.test(slugify("A".repeat(100)))).toBe(true);
  });

  it("picks the first free id and keeps it inside the id rule", () => {
    expect(uniqueId("policy", new Set(), "policy")).toBe("policy");
    expect(uniqueId("policy", new Set(["policy", "policy-2"]), "policy")).toBe("policy-3");
    expect(uniqueId("Not Valid", new Set(), "custom")).toBe("custom");
    const long = "a".repeat(63);
    const next = uniqueId(long, new Set([long]), "x");
    expect(next).toBe(`${"a".repeat(58)}-2`);
    expect(idPattern.test(next)).toBe(true);
  });

  it("new policies and profiles never collide with existing ids", () => {
    expect(newPolicy(new Set(["policy"])).id).toBe("policy-2");
    const profile = newCustomProfile(new Set(["custom", "custom-2"]));
    expect(profile.id).toBe("custom-3");
    expect(profile.entries).toHaveLength(1);
  });
});

describe("lists", () => {
  it("splits commas and lines, trims and drops blanks and repeats", () => {
    expect(splitList(" team-a, team-b\n\nteam-a ,,team-c ")).toEqual(["team-a", "team-b", "team-c"]);
    expect(splitList("")).toEqual([]);
  });
});

describe("names", () => {
  const draft = config({
    custom_profiles: [
      {
        id: "project",
        name: "프로젝트 코드명",
        min_confidence: "low",
        min_matches: 1,
        entries: [{ id: "codename", name: "코드명", type: "keywords", keywords: ["오로라"] }],
      },
    ],
  });

  it("resolves predefined, custom and synthetic profile ids", () => {
    expect(profileName("pii", catalog, draft)).toBe("개인 식별 정보");
    expect(profileName("project", catalog, draft)).toBe("프로젝트 코드명");
    expect(profileName("scan-limit", catalog, draft)).toBe("검사 상한");
    expect(profileName("unknown", catalog, draft)).toBe("unknown");
  });

  it("resolves predefined and custom entry ids", () => {
    expect(entryName("email", catalog, draft)).toBe("이메일 주소");
    expect(entryName("project/codename", catalog, draft)).toBe("코드명");
    expect(entryName("project/missing", catalog, draft)).toBe("project/missing");
  });
});

describe("dirty check", () => {
  it("ignores key order but sees real changes", () => {
    const a = config({ policies: [policy({ id: "p1" })] });
    const reordered = JSON.parse(
      JSON.stringify({
        policies: a.policies,
        oversize: a.oversize,
        max_scan_bytes: a.max_scan_bytes,
        evidence: a.evidence,
        enabled: a.enabled,
        profiles: a.profiles,
        custom_profiles: a.custom_profiles,
      }),
    ) as DLPConfig;
    expect(configFingerprint(reordered)).toBe(configFingerprint(a));
    expect(configFingerprint(config({ ...a, enabled: false }))).not.toBe(configFingerprint(a));
  });
});

describe("strongest action", () => {
  it("takes the strongest enabled action on each side", () => {
    const policies = [
      policy({ id: "flag-both", action: "FLAG", check: ["REQUEST", "RESPONSE"] }),
      policy({ id: "mask-request", action: "MASK", check: ["REQUEST"] }),
      policy({ id: "block-off", action: "BLOCK", check: ["REQUEST", "RESPONSE"], enabled: false }),
    ];
    expect(strongestActions(policies)).toEqual({ REQUEST: "MASK", RESPONSE: "FLAG" });
    expect(strongestActions([])).toEqual({ REQUEST: "", RESPONSE: "" });
  });
});

describe("readiness", () => {
  it("warns when DLP is on but nothing is checked", () => {
    const notes = readinessNotes(
      config({ policies: [policy({ id: "p", enabled: false })], oversize: "block" }),
    );
    expect(notes).toEqual([{ tone: "warning", text: expect.stringContaining("켜진 정책이 없어") as string }]);
  });

  it("explains streaming delay, the scan limit and a disabled switch", () => {
    const texts = readinessNotes(
      config({ enabled: false, policies: [policy({ id: "p", check: ["RESPONSE"] })] }),
    ).map((note) => note.text);
    expect(texts.some((text) => text.includes("DLP가 꺼져 있습니다"))).toBe(true);
    expect(texts.some((text) => text.includes("스트리밍"))).toBe(true);
    expect(texts.some((text) => text.includes("256KiB"))).toBe(true);
  });

  it("formats byte sizes", () => {
    expect(formatBytes(512)).toBe("512B");
    expect(formatBytes(1536)).toBe("1.5KiB");
    expect(formatBytes(1 << 20)).toBe("1MiB");
  });
});

describe("server issues", () => {
  const draft = config({
    policies: [policy({ id: "p1", name: "자격 증명 가리기" })],
    custom_profiles: [
      {
        id: "project",
        name: "프로젝트",
        entries: [{ id: "codename", name: "코드명", type: "regex", pattern: "(" }],
      },
    ],
  });

  it("routes each issue to the tab that holds the field", () => {
    expect(issueTab({ path: "policies[0].profiles", message: "" })).toBe("policies");
    expect(issueTab({ path: "custom_profiles[0].entries[0].pattern", message: "" })).toBe("profiles");
    expect(issueTab({ path: "profiles.pii.min_matches", message: "" })).toBe("profiles");
    expect(issueTab({ path: "max_scan_bytes", message: "" })).toBe("overview");
  });

  it("names the place an issue points at", () => {
    expect(issueLocation({ path: "policies[0].profiles", message: "" }, draft)).toBe("정책 자격 증명 가리기");
    expect(issueLocation({ path: "policies[4]", message: "" }, draft)).toBe("정책 5");
    expect(issueLocation({ path: "custom_profiles[0].entries[0].pattern", message: "" }, draft)).toBe(
      "사용자 프로필 프로젝트 · 항목 코드명",
    );
    expect(issueLocation({ path: "profiles.pii.min_matches", message: "" }, draft)).toBe("기본 프로필 pii");
    expect(issueLocation({ path: "oversize", message: "" }, draft)).toBe("상한 초과 처리");
  });
});

describe("policies", () => {
  it("adds only the recommended policies the draft lacks", () => {
    const draft = config({ policies: [policy({ id: "mask-credentials", action: "FLAG" })] });
    const next = withRecommended(draft, [
      policy({ id: "mask-credentials", action: "MASK", profiles: ["credentials"] }),
      policy({ id: "block-government-ids", action: "BLOCK", profiles: ["government"] }),
    ]);
    expect(next.policies.map((p) => [p.id, p.action])).toEqual([
      ["mask-credentials", "FLAG"],
      ["block-government-ids", "BLOCK"],
    ]);
  });

  it("finds the policies that would dangle if a profile were removed", () => {
    const draft = config({
      policies: [policy({ id: "a", profiles: ["pii", "project"] }), policy({ id: "b", profiles: ["pii"] })],
    });
    expect(policiesUsing(draft, "project").map((p) => p.id)).toEqual(["a"]);
  });
});

describe("highlight", () => {
  it("splits at UTF-8 byte offsets so Korean text around a match stays intact", () => {
    const text = "메일 kim@example.com 로";
    const start = new TextEncoder().encode("메일 ").length;
    const end = start + "kim@example.com".length;
    const parts = highlightParts(text, [
      { start, end, entry_name: "이메일 주소", profile_id: "pii", confidence: "high" },
    ]);
    expect(parts.map((part) => part.text)).toEqual(["메일 ", "kim@example.com", " 로"]);
    expect(parts[1]?.match).toEqual({ entry: "이메일 주소", profile: "pii", confidence: "high" });
  });

  it("keeps the earlier of overlapping matches and ignores out-of-range ones", () => {
    const parts = highlightParts("0123456789", [
      { start: 2, end: 6, entry_name: "a", profile_id: "p", confidence: "low" },
      { start: 4, end: 8, entry_name: "b", profile_id: "p", confidence: "low" },
      { start: 9, end: 40, entry_name: "c", profile_id: "p", confidence: "low" },
    ]);
    expect(parts.map((part) => [part.text, part.match?.entry ?? ""])).toEqual([
      ["01", ""],
      ["2345", "a"],
      ["6789", ""],
    ]);
  });
});

describe("samples", () => {
  it("are synthetic and distinct", () => {
    expect(new Set(dlpSamples.map((sample) => sample.id)).size).toBe(dlpSamples.length);
    for (const sample of dlpSamples) {
      expect(sample.text.length).toBeGreaterThan(20);
    }
    expect(dlpSamples.map((sample) => sample.text).join("\n")).toContain("example.com");
  });
});

describe("change summary", () => {
  it("names what a save would change", () => {
    const base = config({
      enabled: false,
      policies: [
        policy({ id: "keep", name: "유지" }),
        policy({ id: "edit", name: "고칠 정책" }),
        policy({ id: "gone" }),
      ],
    });
    const draft = config({
      enabled: true,
      max_scan_bytes: 1 << 20,
      oversize: "block",
      evidence: "hash_only",
      profiles: { pii: { disabled_entries: ["email"] } },
      custom_profiles: [{ id: "codes", name: "코드명", entries: [] }],
      policies: [
        policy({ id: "keep", name: "유지", enabled: false }),
        policy({ id: "edit", name: "고칠 정책", action: "BLOCK" }),
        policy({ id: "new", name: "새 정책" }),
      ],
    });
    expect(changeSummary(base, draft, catalog)).toEqual([
      "DLP 켜기",
      "정책 끄기: 유지",
      "정책 변경: 고칠 정책",
      "정책 추가: 새 정책",
      "정책 삭제: gone",
      "프로필 조정: 개인 식별 정보",
      "사용자 프로필 추가: 코드명",
      "증거 보관: 지문만",
      "검사 상한: 256KiB → 1MiB",
      "상한 초과: 차단",
    ]);
    expect(changeSummary(base, base, catalog)).toEqual([]);
  });

  it("counts UTF-8 bytes and searches entries by name, id, description and context", () => {
    expect(utf8Bytes("ab가")).toBe(5);
    const email = { id: "email", name: "이메일 주소", description: "", context: ["메일", "mail"] };
    expect(entryMatches(email, "MAIL")).toBe(true);
    expect(entryMatches(email, "주소")).toBe(true);
    expect(entryMatches(email, "카드")).toBe(false);
    expect(entryMatches(email, "  ")).toBe(true);
  });
});
