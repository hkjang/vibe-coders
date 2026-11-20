import { expect, it } from "vitest";
import { policyLegacyHandoff } from "./legacy-policy-map";

const base = "/admin#/safety";
it.each(["policy-one", "정책 +%2F?&#/", "😀".repeat(512), "__proto__"])(
  "정책 ID를 재작성하지 않고 같은 정책으로 연결한다 (%s)",
  (id) => {
    const result = policyLegacyHandoff(base, id, true, []);
    expect(result.samePolicy).toBe(true);
    expect(new URLSearchParams(result.href?.split("?").slice(1).join("?")).get("policy_id")).toBe(id);
  },
);
it.each(["", "trim ", "\u0000", "\ud800", "a".repeat(513), "corp_" + "a".repeat(32)])(
  "안전하지 않은 ID는 선택 주소에 넣지 않는다 (%s)",
  (id) => {
    expect(policyLegacyHandoff(base, id, true, ["corp_"])).toEqual({ href: base, samePolicy: false });
  },
);
it("미지원 서버와 사용자 지정 목적지는 등록된 기존 화면을 그대로 연다", () => {
  expect(policyLegacyHandoff(base, "id", false, [])).toEqual({ href: base, samePolicy: false });
  expect(policyLegacyHandoff("/admin#/safety?tab=custom", "id", true, [])).toEqual({
    href: "/admin#/safety?tab=custom",
    samePolicy: false,
  });
});
it.each([
  undefined,
  "https://elsewhere.invalid/admin",
  "/admin/../auth",
  "/admin#/safety?token=corp_" + "x".repeat(40),
])("허용되지 않은 목적지는 링크를 만들지 않는다 (%s)", (href) => {
  expect(policyLegacyHandoff(href, "id", true, ["corp_"])).toEqual({ samePolicy: false });
});
