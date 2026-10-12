import { describe, expect, it } from "vitest";
import { assertChangeSetResponse } from "./change-set-response";
import type { LifecycleAction } from "./change-set-model";

describe("변경 세트 완료 응답", () => {
  it.each([
    ["submit", { id: "review-id", status: "pending" }],
    ["approve", { id: "review-id", status: "approved" }],
    ["apply", { status: "applied", change_set: { id: "review-id", status: "applied" } }],
    ["rollback", { status: "rolled_back", change_set: { id: "review-id", status: "rolled_back" } }],
    ["delete", { status: "deleted" }],
  ] satisfies [LifecycleAction, unknown][])("%s 완료의 대상과 상태를 확인한다", (action, value) => {
    expect(() => assertChangeSetResponse(action, "review-id", value)).not.toThrow();
  });
  it.each([
    null,
    {},
    { status: "approved" },
    { status: "applied" },
    { status: "applied", change_set: { id: "other-id", status: "applied" } },
    { status: "applied", change_set: { id: "review-id", status: "approved" } },
  ])("불완전하거나 다른 대상인 적용 응답을 성공으로 알리지 않는다: %j", (value) => {
    expect(() => assertChangeSetResponse("apply", "review-id", value)).toThrow(
      "변경 완료 응답을 확인하지 못했습니다.",
    );
  });
});
