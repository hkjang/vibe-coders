import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { meKeyErrorMessage } from "./me-key-errors";

describe("개인 키 오류 안내", () => {
  it.each([
    ["invalid_key_rotation", "유예 기간"],
    ["key_rotation_conflict", "최신 목록"],
    ["key_rotation_authority_unavailable", "팀 권한"],
    ["key_rotate_failed", "다시 요청하지 말고"],
    ["key_scopes_conflict", "다시 검토"],
    ["key_update_failed", "변경 결과"],
  ])("%s 코드를 한글 고정 문구로 표시한다", (code, fragment) => {
    const error = new AppError("SYNTHETIC_PRIVATE_SERVER_MESSAGE", { kind: "http", code });
    expect(meKeyErrorMessage(error, "작업 실패")).toContain(fragment);
    expect(meKeyErrorMessage(error, "작업 실패")).not.toContain(error.message);
  });
  it("알 수 없는 코드와 원문은 표시하지 않고 공통 오류 처리를 유지한다", () => {
    const error = new AppError("SYNTHETIC_PRIVATE_SERVER_MESSAGE", { kind: "http", code: "unknown" });
    expect(meKeyErrorMessage(error, "작업 실패")).toBe("작업 실패");
    expect(meKeyErrorMessage(new AppError("private", { kind: "permission" }), "작업 실패")).toBe(
      "이 작업을 수행할 권한이 없습니다.",
    );
    expect(meKeyErrorMessage(new Error("private"), "작업 실패")).toBe("작업 실패");
  });
});
