import { describe, expect, it } from "vitest";
import { redTeamTargetSchema } from "@/shared/api/domains/redteam";
import { matchesTarget, targetLabel } from "./target-search";

const target = redTeamTargetSchema.parse({
  id: "target-public",
  target_type: "provider",
  target_ref: "provider:public",
  provider: "PublicCloud",
  owner_team: "플랫폼팀",
  risk_level: "high",
  metadata: { title: "서울 제공자", hidden_note: "검색하지않을메모" },
});

describe("레드팀 대상 검색", () => {
  it("화면에 보이는 한글 이름·유형·위험도로 찾는다", () => {
    expect(["서울", "제공자", "높음", "플랫폼팀"].every((query) => matchesTarget(target, query))).toBe(true);
    expect(matchesTarget(target, "낮음")).toBe(false);
  });
  it("기존 식별자와 대소문자·공백을 허용한다", () => {
    expect(
      ["publiccloud", " PROVIDER ", "HIGH", "provider:public"].every((query) => matchesTarget(target, query)),
    ).toBe(true);
    expect(matchesTarget(target, "  ")).toBe(true);
  });
  it("한글 조합 방식이 달라도 같은 표시 이름을 찾는다", () => {
    expect(matchesTarget(target, "서울".normalize("NFD"))).toBe(true);
    expect(matchesTarget({ ...target, metadata: { title: "서울".normalize("NFD") } }, "서울")).toBe(true);
  });
  it("임의 메타데이터 전체를 검색에 포함하지 않는다", () => {
    expect(matchesTarget(target, "검색하지않을메모")).toBe(false);
    expect(targetLabel({ ...target, metadata: { title: {}, name: "표시 이름" } })).toBe("표시 이름");
  });
  it("알려지지 않은 유형·위험도는 원래 식별자로 찾는다", () => {
    const custom = { ...target, target_type: "__proto__", risk_level: "constructor" };
    expect(matchesTarget(custom, "__proto__")).toBe(true);
    expect(matchesTarget(custom, "constructor")).toBe(true);
  });
  it("이름이 없는 도구와 모델의 기존 표시 대체값을 사용한다", () => {
    expect(targetLabel({ ...target, metadata: {}, tool_name: "public-search" })).toBe("public-search");
    expect(matchesTarget({ ...target, metadata: {}, model: "public-model" }, "public-model")).toBe(true);
    expect(targetLabel({ ...target, metadata: {} })).toBe("provider:public");
  });
});
