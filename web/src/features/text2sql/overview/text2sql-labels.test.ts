import { describe, expect, it } from "vitest";

import { permissionActionLabel, permissionSubjectLabel } from "./text2sql-labels";

describe("Text2SQL 권한 표시 이름", () => {
  it("주체 코드와 한글 이름을 분리한다", () => {
    expect(permissionSubjectLabel("team")).toBe("팀");
    expect(permissionSubjectLabel("api_key")).toBe("API 키");
    expect(permissionSubjectLabel("user")).toBe("사용자");
    expect(permissionSubjectLabel("*")).toBe("전체(*)");
  });

  it("알려진 동작만 번역하고 알 수 없는 동작을 허용으로 표시하지 않는다", () => {
    expect(permissionActionLabel("deny")).toBe("차단");
    expect(permissionActionLabel("allow")).toBe("허용");
    expect(permissionActionLabel("future_action")).toBe("future_action");
    expect(permissionSubjectLabel("future_subject")).toBe("future_subject");
    expect(permissionActionLabel("")).toBe("—");
  });
});
