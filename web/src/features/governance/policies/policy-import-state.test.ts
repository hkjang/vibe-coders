import { describe, expect, it } from "vitest";
import { confirmPolicyAck, validatePolicyDocument } from "@/shared/api/domains/policy-import";
import {
  ExactPolicyNumber,
  parsePolicyJSON,
  policyImportLimits,
} from "@/shared/api/domains/policy-import-json";
import {
  effectivePolicy,
  importDisplay,
  importImpacts,
  parseCurrentExport,
  parseImportFile,
  samePolicies,
} from "./policy-import-state";

const bytes = (text: string) => new TextEncoder().encode(text).buffer;
const wrap = (value: string) =>
  `{"policies":[{"id":"p","name":"공개 정책","rules":[{"id":"r","conditions":{"future":${value}}}]}]}`;
const parse = (text: string) => parseImportFile(bytes(text), "public.json").body;
const exported = (value: string) =>
  parseCurrentExport(
    bytes(
      `{"version":1,"count":1,"policies":[{"id":"p","name":"공개 정책","description":"","enabled":false,"priority":100,"rollout_percent":100,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z","rules":[{"id":"r","policy_id":"p","name":"","enabled":false,"priority":100,"conditions":{"future":${value}},"actions":{},"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z"}]}]}`,
    ),
  );

describe("정책 가져오기 파일 값과 실제 계약 경계", () => {
  it.each(["description", "enabled", "priority", "rollout_percent", "created_at", "updated_at"])(
    "export 정책 필수 %s 누락/null을 기본값으로 간주하지 않는다",
    (field) => {
      const row: Record<string, unknown> = {
        id: "p",
        name: "공개",
        description: "",
        enabled: false,
        priority: 100,
        rollout_percent: 100,
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
        rules: [],
      };
      Reflect.deleteProperty(row, field);
      expect(() =>
        parseCurrentExport(bytes(JSON.stringify({ version: 1, count: 1, policies: [row] }))),
      ).toThrow();
      row[field] = null;
      expect(() =>
        parseCurrentExport(bytes(JSON.stringify({ version: 1, count: 1, policies: [row] }))),
      ).toThrow();
    },
  );
  it.each(["policy_id", "name", "enabled", "priority", "conditions", "actions", "created_at", "updated_at"])(
    "export 규칙 필수 %s 누락/null을 기본값으로 간주하지 않는다",
    (field) => {
      const rule: Record<string, unknown> = {
        id: "r",
        policy_id: "p",
        name: "",
        enabled: false,
        priority: 100,
        conditions: {},
        actions: {},
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
      };
      const policy = {
        id: "p",
        name: "공개",
        description: "",
        enabled: false,
        priority: 100,
        rollout_percent: 100,
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
        rules: [rule],
      };
      Reflect.deleteProperty(rule, field);
      expect(() =>
        parseCurrentExport(bytes(JSON.stringify({ version: 1, count: 1, policies: [policy] }))),
      ).toThrow();
      rule[field] = null;
      expect(() =>
        parseCurrentExport(bytes(JSON.stringify({ version: 1, count: 1, policies: [policy] }))),
      ).toThrow();
    },
  );
  it.each(["0.1", "1.2300", "1e2", "1e-7", "9007199254740991", "-7"])(
    "안전한 십진 값 %s를 보존한다",
    (token) => {
      expect(parse(wrap(token)).policies[0]?.rules?.[0]?.conditions).toEqual({ future: Number(token) });
    },
  );
  it.each(["9007199254740993", "1.0000000000000001", "0.10000000000000001", "-0", "-0e2", "1e309", "1e-400"])(
    "손실 또는 지원 밖 숫자 %s는 전송 전에 거절한다",
    (token) => {
      expect(() => parse(wrap(token))).toThrow();
    },
  );
  it.each(['{"a":1,"\\u0061":2}', '{"nested":{"x":1,"x":2}}', "[] {}", '{"x":1,}', '"\\uD800"'])(
    "중복/문법/문자 경계 %s를 거절한다",
    (value) => {
      expect(() => parsePolicyJSON(value)).toThrow();
    },
  );
  it("UTF-8 오류와 BOM을 몰래 치환하거나 제거하지 않는다", () => {
    expect(() => parseImportFile(new Uint8Array([0xff]).buffer, "public.json")).toThrow(/UTF-8/);
    expect(() => parseImportFile(bytes('\uFEFF{"policies":[]}'), "public.json")).toThrow();
  });
  it("64개 컨테이너는 허용하고 65개는 거절한다", () => {
    expect(() => parsePolicyJSON("[".repeat(64) + "0" + "]".repeat(64))).not.toThrow();
    expect(() => parsePolicyJSON("[".repeat(65) + "0" + "]".repeat(65))).toThrow(/64/);
  });
  it("opaque prototype 이름을 own 데이터로 보존하고 prototype을 오염시키지 않는다", () => {
    const raw = wrap(
      '{"__proto__":{"polluted":"public"},"constructor":{"prototype":{"nested":1}},"prototype":2}',
    );
    const body = parse(raw);
    expect(JSON.parse(JSON.stringify(body))).toEqual(JSON.parse(raw));
    const conditions = body.policies[0]?.rules?.[0]?.conditions as Record<string, unknown>;
    expect(Object.getPrototypeOf(conditions)).toBeNull();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
  it.each(['"ID":"p"', '"unexpected":true', '"priority":1.2'])(
    "typed 필드 alias/unknown/비정수 %s를 조용히 무시하지 않는다",
    (fragment) => {
      expect(() => parse(`{"policies":[{"id":"p","name":"공개",${fragment}}]}`)).toThrow();
    },
  );
  it("정책/규칙 중복, 다른 부모, 빈 ID, NEL만 이름을 거절하고 FEFF는 보존한다", () => {
    for (const policies of [
      [
        { id: "p", name: "공개" },
        { id: "p", name: "둘째" },
      ],
      [{ id: "p", name: "공개", rules: [{ id: "r" }, { id: "r" }] }],
      [{ id: "p", name: "공개", rules: [{ id: "r", policy_id: "other" }] }],
      [{ id: "", name: "공개" }],
      [{ id: "p", name: "\u0085" }],
    ])
      expect(() => parse(JSON.stringify({ policies }))).toThrow();
    expect(parse('{"policies":[{"id":" p ","name":"\uFEFF"}]}').policies[0]?.id).toBe(" p ");
  });
  it("파일 원문과 직렬화 본문 크기를 각각 제한한다", () => {
    expect(() => parseImportFile(new ArrayBuffer(policyImportLimits.bytes + 1), "public.json")).toThrow(
      /4 MiB/,
    );
    // JSON.stringify escapes literal U+0000; already escaped input does not bypass the check.
    expect(() => parse('{"policies":[]}')).toThrow(/없습니다/);
  });
  it("정책 1000개 및 규칙 10000개 상한을 검사한다", () => {
    const policies = Array.from({ length: 1000 }, (_, index) => ({ id: `p${index}`, name: "공개" }));
    expect(validatePolicyDocument({ policies }).policies).toHaveLength(1000);
    expect(() =>
      validatePolicyDocument({ policies: [...policies, { id: "overflow", name: "공개" }] }),
    ).toThrow(/1,000/);
    const rules = Array.from({ length: 10000 }, (_, index) => ({ id: `r${index}` }));
    expect(
      validatePolicyDocument({ policies: [{ id: "p", name: "공개", rules }] }).policies[0]?.rules,
    ).toHaveLength(10000);
    expect(() =>
      validatePolicyDocument({
        policies: [{ id: "p", name: "공개", rules: [...rules, { id: "overflow" }] }],
      }),
    ).toThrow(/10,000/);
  });
  it("nil/null 보존과 [] 제거 및 서버 기본값을 표시만 계산한다", () => {
    const baseline = parse('{"policies":[{"id":"p","name":"이전","rules":[{"id":"r","priority":-5}]}]}');
    for (const suffix of ["", ',"rules":null']) {
      const body = parse(
        `{"policies":[{"id":"p","name":"다음","priority":0,"rollout_percent":-4${suffix}}]}`,
      );
      const before = JSON.stringify(body);
      expect(importImpacts(body, baseline)[0]).toMatchObject({
        mode: "기존 규칙 유지",
        removed: 0,
        after: { priority: 100, rollout_percent: 100, enabled: false },
      });
      expect(JSON.stringify(body)).toBe(before);
    }
    expect(
      importImpacts(parse('{"policies":[{"id":"p","name":"다음","rules":[]}]}'), baseline)[0]?.removed,
    ).toBe(1);
    expect(
      effectivePolicy({
        id: "p",
        name: "공개",
        priority: -5,
        rollout_percent: 37,
        rules: [{ id: "r", policy_id: "", priority: 0, rollout_percent: 25, updated_at: "old" }],
      }).rules?.[0],
    ).toEqual({
      id: "r",
      policy_id: "p",
      name: "",
      enabled: false,
      priority: 100,
      conditions: {},
      actions: {},
    });
  });
  it("export의 비안전 opaque 숫자는 lossless 비교만 하며 가져오기로 자동 전송하지 않는다", () => {
    const baseline = exported("9007199254740993");
    const nested = baseline.policies[0]?.rules?.[0]?.conditions as Record<string, unknown>;
    expect(nested.future).toBeInstanceOf(ExactPolicyNumber);
    expect(importDisplay(nested, [])).toContain("9007199254740993");
    expect(samePolicies(baseline, exported("9007199254740993"))).toBe(true);
    expect(samePolicies(baseline, exported("9007199254740992"))).toBe(false);
    expect(() => parse(wrap("9007199254740993"))).toThrow();
  });
  it("export envelope와 rules 배열을 명시 확인하고 전체 기준의 시각 변경도 감지한다", () => {
    expect(() =>
      parseCurrentExport(bytes('{"version":1,"count":1,"policies":[{"id":"p","name":"공개"}]}')),
    ).toThrow();
    const left = exported("0.1");
    const right = exported("0.10");
    expect(samePolicies(left, right)).toBe(true);
    if (right.policies[0]) right.policies[0].updated_at = "changed";
    expect(samePolicies(left, right)).toBe(false);
  });
  it("현재 prefix와 민감 키를 표시에서만 가리고 실제 policy 어휘는 유지한다", () => {
    expect(importDisplay({ future: `custom_${"a".repeat(32)}` }, ["custom_"])).toMatch(/표시하지/);
    expect(importDisplay({ access_token: "public" }, [])).toMatch(/표시하지/);
    expect(importDisplay({ contains_secret: true, secret_action: "mask" }, [])).toContain("contains_secret");
  });
  it("ACK는 제출 ID/name/명시 규칙 수·created/updated 합을 확인하되 CAS로 오인하지 않는다", () => {
    const body = parse('{"policies":[{"id":"p","name":"공개","rules":null}]}');
    const ack = {
      dry_run: false,
      created: 0,
      updated: 1,
      plan: [{ id: "p", name: "공개", action: "update", rules: 0 }],
    };
    expect(confirmPolicyAck(ack, body, false)).toEqual(ack);
    for (const invalid of [
      { ...ack, dry_run: true },
      { ...ack, updated: 2 },
      { ...ack, plan: [] },
      { ...ack, plan: [{ ...ack.plan[0], rules: 2 }] },
    ])
      expect(() => confirmPolicyAck(invalid, body, false)).toThrow();
  });
});
