import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ModelUsageTag } from "@/shared/api/schemas";
import { displayTagModel } from "./model-tag-state";
import { edit, modelA, nativeSubmit, review, row, savePath, setup } from "./model-tag-test-harness";

describe("모델 태그 검토의 로컬 레이아웃 경계", () => {
  it("삭제의 긴 원본 ID는 짧은 설명과 분리된 정의 영역에 생략 없이 표시하고 취소는 전송하지 않는다", async () => {
    const id = `\ufeff한글/100%?${"public".repeat(25)}`;
    const current = await setup([row(id, "공개 긴 ID")]);
    const trigger = screen.getByRole("button", { name: "삭제" });
    await current.user.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "모델 용도 태그 삭제" });
    const descriptionId = dialog.getAttribute("aria-describedby");
    if (!descriptionId) throw new Error("missing actual dialog description");
    expect.soft(document.getElementById(descriptionId)?.textContent).not.toContain(displayTagModel(id));
    const target = within(dialog).getByText(displayTagModel(id), { exact: true });
    expect(target.tagName).toBe("DD");
    expect(target.textContent).toBe(displayTagModel(id));
    await current.user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(current.api.calls.filter((call) => call.key.startsWith("DELETE"))).toEqual([]);
  });

  it("검토 도구는 blur 오류가 삽입되는 입력보다 앞에 있고 첫 클릭은 첫 오류로 초점을 보낸다", async () => {
    const current = await setup();
    await current.user.click(screen.getByRole("button", { name: "태그 추가" }));
    const dialog = screen.getByRole("dialog", { name: "모델 용도 태그" });
    const model = within(dialog).getByRole("textbox", { name: "모델" });
    const prepare = within(dialog).getByRole("button", { name: "변경 내용 검토" });
    await current.user.type(model, "\u0085 ");
    // jsdom cannot prove pointer geometry; the actual browser regression owns
    // the first physical click count and unchanged button/footer coordinates.
    expect.soft(prepare.compareDocumentPosition(model) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await current.user.click(prepare);
    expect(await within(dialog).findByText("모델 이름을 입력하세요.")).toBeInTheDocument();
    await waitFor(() => expect(model).toHaveFocus());
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(current.api.bodies(savePath)).toEqual([]);
  });

  it("상단 검토 도구도 권한 제한 때 잠기며 열린 입력과 수동 복구를 유지한다", async () => {
    const current = await setup();
    const dialog = await edit(current);
    const prepare = within(dialog).getByRole("button", { name: "변경 내용 검토" });
    current.update("read_only");
    expect(prepare).toBeDisabled();
    expect(within(dialog).getByRole("textbox", { name: "적합한 작업" })).toHaveValue("revised-a");
    current.update("writable");
    expect(prepare).toBeEnabled();
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    expect(current.api.bodies(savePath)).toEqual([]);
  });

  it("검토 표는 긴 원문과 행 의미를 보존하고 pending 본문 읽기 초점은 잠긴 필드 밖에 있다", async () => {
    const originalText = `긴원문${"공개작업".repeat(100)}\n두 번째 원문 줄`;
    const current = await setup([row(modelA, originalText)]);
    const dialog = await edit(current, originalText);
    await review(current, dialog);
    const table = within(dialog).getByRole("table", { name: "태그 변경 전후 비교" });
    expect(within(table).getAllByRole("rowheader")).toHaveLength(4);
    expect(within(table).getAllByRole("columnheader")).toHaveLength(3);
    expect(within(table).getByText(originalText, { normalizer: (value) => value }).textContent).toBe(
      originalText,
    );
    // The comparison now shares the dialog body's one scroll surface instead
    // of a nested scroll region disabled by FormDialog's pending fieldset.
    expect.soft(table.closest(".data-table-scroll")).toBeNull();
    let release: ((value: ModelUsageTag) => void) | undefined;
    current.response.save = () => new Promise<ModelUsageTag>((resolve) => (release = resolve));
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "변경 내용 검토" })).toBeDisabled();
    const hint = within(dialog).getByText(
      "초안은 자동 저장되지 않습니다. 내용이 길면 이 안내에 초점을 둔 뒤 위·아래 방향키로 살펴보세요.",
    );
    expect(hint.closest("fieldset:disabled")).toBeNull();
    expect(hint).toHaveAttribute("tabindex", "0");
    expect(within(table).getByText(originalText, { normalizer: (value) => value }).textContent).toBe(
      originalText,
    );
    await act(async () => release?.(row(modelA, "revised-a")));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });
});
