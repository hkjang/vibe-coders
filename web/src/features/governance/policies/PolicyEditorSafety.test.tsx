import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { policy, savePath, setupEditor } from "./policy-editor-test-harness";

describe("기존 정책 조회 정상 대조", () => {
  it("원래 목록과 활성화 동작을 유지하고 조회만으로 저장하지 않는다", async () => {
    const current = await setupEditor();
    expect(await screen.findByRole("button", { name: "공개 초안 사용" })).toBeEnabled();
    expect(current.api.bodies(savePath)).toEqual([]);
    expect(current.api.bodies("GET /admin/policies")).toHaveLength(1);
  });
});
describe("비활성 정책 편집 진입", () => {
  it("취소는 원래 행의 현재 편집 버튼으로 초점을 돌리고 쓰지 않는다", async () => {
    const current = await setupEditor();
    await current.user.click(current.open());
    await current.user.click(screen.getByRole("button", { name: "취소" }));
    await waitFor(() => expect(current.open()).toHaveFocus());
    expect(current.api.bodies(savePath)).toEqual([]);
  });
  it("복수 규칙의 원본을 검토할 편집창을 연다", async () => {
    const current = await setupEditor();
    await current.user.click(current.open());
    expect(current.dialog()).toBeVisible();
    expect(screen.getByRole("textbox", { name: "정책 이름" })).toHaveValue(policy.name);
    expect(screen.getAllByRole("textbox", { name: "규칙 이름" })).toHaveLength(2);
    expect(current.api.bodies(savePath)).toEqual([]);
  });
});
