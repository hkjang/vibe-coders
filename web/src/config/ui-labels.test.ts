import { describe, expect, it } from "vitest";

import { roleLabel } from "@/config/ui-labels";

describe("roleLabel", () => {
  it.each([
    ["super_admin", "최고 관리자"],
    ["admin", "관리자"],
    ["ops_admin", "운영 관리자"],
    ["ai_admin", "AI 관리자"],
    ["security_admin", "보안 관리자"],
    ["billing_admin", "비용 관리자"],
    ["readonly_admin", "읽기 전용 관리자"],
    ["team_admin", "팀 관리자"],
    ["team_manager", "팀 운영자"],
    ["developer", "개발자"],
    ["viewer", "조회자"],
    ["operator", "운영자"],
    ["service_account", "서비스 계정"],
    ["legacy_admin", "기존 관리자"],
  ])("translates the %s role", (role, expected) => {
    expect(roleLabel(role)).toBe(expected);
  });

  it("normalizes known codes but never reflects an unknown role", () => {
    expect(roleLabel(" ADMIN ")).toBe("관리자");
    expect(roleLabel("private_custom_role")).toBe("확인 불가");
    expect(roleLabel(undefined)).toBe("확인 불가");
  });
});
