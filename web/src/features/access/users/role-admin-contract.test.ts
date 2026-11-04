import { describe, expect, it } from "vitest";
import { roleAdminSchema } from "@/shared/api/domains/access.schemas";

const role = {
  role: "reviewer",
  scopes: ["models:read"],
  description: "검토자",
  default_home: "",
  is_system: false,
};
const catalog = { roles: [role], all_scopes: ["models:read"] };

describe("역할 변경 전 조회 계약", () => {
  it("명시적인 빈 권한과 null은 미부여로 읽되 기존 설정을 보존한다", () => {
    for (const scopes of [[], null]) {
      expect(roleAdminSchema.parse({ ...catalog, roles: [{ ...role, scopes }] }).roles[0]).toMatchObject({
        ...role,
        scopes: [],
      });
    }
  });
  it.each(["role", "scopes", "description", "default_home", "is_system"] as const)(
    "%s 누락을 기본값으로 바꾸어 변경 검토에 사용하지 않는다",
    (field) => {
      const incomplete = Object.fromEntries(Object.entries(role).filter(([key]) => key !== field));
      expect(roleAdminSchema.safeParse({ ...catalog, roles: [incomplete] }).success).toBe(false);
    },
  );
  it.each([
    { roles: [], all_scopes: ["models:read"] },
    { roles: [role, role], all_scopes: ["models:read"] },
    { roles: [role], all_scopes: [] },
    { roles: [role] },
    { roles: [{ ...role, is_system: "false" }], all_scopes: ["models:read"] },
    { roles: [{ ...role, role: " reviewer" }], all_scopes: ["models:read"] },
    { roles: [{ ...role, scopes: ["models:read\n"] }], all_scopes: ["models:read"] },
  ])("불완전하거나 모호한 목록은 거부한다 (%#)", (response) => {
    expect(roleAdminSchema.safeParse(response).success).toBe(false);
  });
  it("목록 밖 기존 권한은 사용자 확인을 위해 보존한다", () => {
    const scopes = ["models:read", "future:scope"];
    expect(roleAdminSchema.parse({ ...catalog, roles: [{ ...role, scopes }] }).roles[0]?.scopes).toEqual(
      scopes,
    );
  });
});
