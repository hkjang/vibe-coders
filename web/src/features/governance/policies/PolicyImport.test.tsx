import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setupEditor } from "./policy-editor-test-harness";

describe("정책 가져오기 실제 진입점", () => {
  it("기존 목록과 비활성 편집 진입점을 보존한다", async () => {
    const current = await setupEditor();
    expect(screen.getByRole("table", { name: "AI 정책 목록" })).toHaveTextContent("공개 초안");
    expect(current.open()).toBeEnabled();
    expect(current.api.bodies("POST /admin/policies")).toEqual([]);
  });
  it("실제 목록에서 가져오기 창을 열며 아직 저장하지 않는다", async () => {
    const current = await setupEditor();
    await current.user.click(screen.getByRole("button", { name: "정책 가져오기" }));
    expect(screen.getByRole("dialog", { name: "정책 가져오기" })).toBeVisible();
    expect(screen.getByLabelText("정책 JSON 파일")).toHaveAttribute("type", "file");
    expect(current.api.bodies("POST /admin/policies")).toEqual([]);
  });
});
