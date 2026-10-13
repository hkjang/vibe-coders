import { describe, expect, it } from "vitest";
import { createKeySchema } from "./api-key-form";

const input = {
  name: "비용 상한 검사 키",
  owner: "",
  team: "",
  role: "",
  allowed_ips: "",
  allowed_models: "",
  denied_models: "",
  budget_limit_krw: "",
  expires_at: "",
  scopes: [],
};

describe("관리자 키 요청별 비용 상한", () => {
  it.each(["-1", "Infinity", "NaN", "not-a-number"])(
    "잘못된 금액 %s을 무제한 발급으로 바꾸지 않는다",
    (value) => {
      expect(createKeySchema.safeParse({ ...input, budget_limit_krw: value }).success).toBe(false);
    },
  );
  it.each(["", "0", "0.5", "1000", "1e3"])("기존에 허용된 금액 %s은 유지한다", (value) => {
    expect(createKeySchema.safeParse({ ...input, budget_limit_krw: value }).success).toBe(true);
  });
});
