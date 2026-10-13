import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { keyEditError } from "./key-edit-error";

describe("키 수정 오류 안내", () => {
  it.each([
    [409, "key_update_conflict", "키 정보가 변경되어 저장하지 않았습니다"],
    [400, "invalid_key_update", "변경 항목과 사유를 확인할 수 없어 저장하지 않았습니다"],
    [503, "key_update_authority_unavailable", "검토 정보를 확인할 수 없어 저장하지 않았습니다"],
    [500, "key_update_conflict", "저장 결과를 확인할 수 없습니다"],
    [503, "api_key_update_failed", "저장 결과를 확인할 수 없습니다"],
  ] as const)("%i/%s 응답을 구분하고 원문은 노출하지 않는다", (status, code, expected) => {
    const message = keyEditError(
      new AppError("private response", { kind: "http", status, code }),
      "저장하지 못했습니다.",
    );
    expect(message).toContain(expected);
    expect(message).not.toContain("private response");
  });
  it.each(["network", "timeout"] as const)("%s 실패에 자동 재시도를 안내하지 않는다", (kind) => {
    expect(keyEditError(new AppError("private response", { kind }), "오류")).toContain("재전송하지 말고");
  });
});
