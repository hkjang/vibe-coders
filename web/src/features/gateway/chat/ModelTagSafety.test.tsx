import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import type { ModelUsageTag } from "@/shared/api/schemas";
import { tokenStore } from "@/shared/auth/token-store";
import {
  edit,
  modelA,
  modelB,
  getModelTagToasts,
  nativeSubmit,
  review,
  row,
  savePath,
  setup,
} from "./model-tag-test-harness";
const toast = getModelTagToasts();

describe("모델 태그 정상 동작 대조", () => {
  it("control: 기존 ID의 적합 필드 수정은 정확히 같은 A에 1 POST", async () => {
    const current = await setup();
    const beforeB = { ...current.records.get(modelB) };
    const dialog = await edit(current);
    await review(current, dialog);
    await nativeSubmit(dialog);
    await waitFor(() => expect(current.api.bodies(savePath)).toHaveLength(1));
    expect(current.api.bodies(savePath)).toEqual([
      { model: modelA, good_for: "revised-a", avoid_for: "public-avoid", risk_note: "public-risk" },
    ]);
    expect(current.records.get(modelA)?.good_for).toBe("revised-a");
    expect(current.records.get(modelB)).toEqual(beforeB);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
  });

  it("control: 폼을 열기 전 admin:write가 없으면 기존 수정 버튼은 잠긴다", async () => {
    const current = await setup();
    current.update("writable", false);
    for (const button of screen.getAllByRole("button", { name: "수정" })) expect(button).toBeDisabled();
    expect(screen.getByRole("button", { name: "태그 추가" })).toBeDisabled();
    expect(current.api.bodies(savePath)).toEqual([]);
  });
});

describe("모델 태그 열린 초안의 실제 제출 보호 재현", () => {
  for (const mode of ["read_only", "preview_read_only"] as const) {
    it(`${mode}: 이미 열린 dirty 폼은 native submit 뒤 POST 0이어야 한다`, async () => {
      const current = await setup();
      const dialog = await edit(current);
      await review(current, dialog);
      current.update(mode);
      expect(within(dialog).getByRole("textbox", { name: "적합한 작업" })).toHaveValue("revised-a");
      await nativeSubmit(dialog);
      // The native listener above proves a real submit event reached React;
      // this is not a forced disabled-button click or a mock permission denial.
      expect(current.api.bodies(savePath)).toEqual([]);
      expect(current.records.get(modelA)?.good_for).toBe("original-a");
    });
  }

  it("scope 회수: 이미 열린 dirty 폼은 native submit 뒤 POST 0이어야 한다", async () => {
    const current = await setup();
    const createButton = screen.getByRole("button", { name: "태그 추가" });
    const dialog = await edit(current);
    await review(current, dialog);
    current.update("writable", false);
    expect(createButton).toBeDisabled();
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toEqual([]);
    expect(current.records.get(modelA)?.good_for).toBe("original-a");
  });

  it("수정 대상 불변: A 편집에서 모델 B 입력을 시도해도 B upsert로 바뀌지 않아야 한다", async () => {
    const current = await setup();
    const beforeB = { ...current.records.get(modelB) };
    const dialog = await edit(current);
    const model = within(dialog).getByRole("textbox", { name: "모델" });
    await current.user.click(model);
    await current.user.keyboard("{Control>}a{/Control}");
    await current.user.keyboard(modelB);
    await review(current, dialog);
    await nativeSubmit(dialog);
    await waitFor(() => expect(current.api.bodies(savePath)).toHaveLength(1));
    // This is not a rename expectation: editing A must preserve A's immutable
    // identifier because the existing server treats a B payload as a B upsert.
    expect.soft(current.api.bodies(savePath)[0]).toMatchObject({ model: modelA, good_for: "revised-a" });
    expect(current.records.get(modelB)).toEqual(beforeB);
  });

  it("FEFF 식별자: 모델 입력을 손대지 않은 수정도 plain 이웃을 덮지 않아야 한다", async () => {
    const opaque = `\ufeff${modelA}`;
    const current = await setup([row(modelA, "plain-guidance"), row(opaque, "opaque-guidance")]);
    const beforePlain = { ...current.records.get(modelA) };
    const dialog = await edit(current, "opaque-guidance");
    expect(within(dialog).getByRole("textbox", { name: "모델" })).toHaveValue(opaque);
    await review(current, dialog);
    await nativeSubmit(dialog);
    await waitFor(() => expect(current.api.bodies(savePath)).toHaveLength(1));
    expect.soft(current.api.bodies(savePath)[0]).toMatchObject({ model: opaque, good_for: "revised-a" });
    expect(current.records.get(modelA)).toEqual(beforePlain);
  });
});

describe("모델 태그 검토·조회·삭제 회귀", () => {
  it("GET 503의 Request ID는 목록·편집·삭제에서 표시하고 쓰기 요청은 보내지 않는다", async () => {
    const current = await setup();
    const dialog = await edit(current);
    current.response.read = () => {
      throw new AppError("public read unavailable", {
        kind: "http",
        status: 503,
        requestId: "public-read-503",
      });
    };
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    expect(await within(dialog).findByText("요청 ID: public-read-503")).toBeInTheDocument();
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toHaveLength(0);
    await current.user.click(within(dialog).getByRole("button", { name: "취소" }));
    await current.user.click(screen.getByRole("button", { name: "변경 버리기" }));
    expect(await screen.findByText("요청 ID: public-read-503")).toBeInTheDocument();
    const trigger = screen.getAllByRole("button", { name: "삭제" })[0];
    if (!trigger) throw new Error("no delete trigger");
    await current.user.click(trigger);
    const deletion = screen.getByRole("dialog");
    expect(within(deletion).getByText("요청 ID: public-read-503")).toBeInTheDocument();
    expect(within(deletion).getByRole("button", { name: "삭제" })).toBeDisabled();
    expect(current.api.calls.filter((call) => call.key.startsWith("DELETE"))).toHaveLength(0);
    expect(current.api.calls.filter((call) => call.key === "GET /admin/model-tags")).toHaveLength(2);
  });
  it("검토 후 값을 바꾸면 확인을 폐기하고 재검토해야 저장한다", async () => {
    const current = await setup();
    const dialog = await edit(current);
    await review(current, dialog);
    await current.user.type(within(dialog).getByRole("textbox", { name: "적합한 작업" }), " changed");
    expect(within(dialog).queryByRole("checkbox")).not.toBeInTheDocument();
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toHaveLength(0);
    await review(current, dialog);
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toHaveLength(1);
  });
  it("readonly 복구는 초안을 유지하고 자동 저장 없이 명시적 수동 제출", async () => {
    const current = await setup();
    const dialog = await edit(current);
    await review(current, dialog);
    current.update("read_only");
    await nativeSubmit(dialog);
    current.update("writable");
    expect(within(dialog).getByRole("textbox", { name: "적합한 작업" })).toHaveValue("revised-a");
    expect(current.api.bodies(savePath)).toHaveLength(0);
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toHaveLength(1);
  });
  it("동일 ID 추가는 덮어쓰기 기준을 표시하고 명시적으로 확인", async () => {
    const current = await setup();
    await current.user.click(screen.getByRole("button", { name: "태그 추가" }));
    const dialog = screen.getByRole("dialog", { name: "모델 용도 태그" });
    await current.user.type(within(dialog).getByRole("textbox", { name: "모델" }), modelA);
    await current.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
    expect(
      within(dialog).getByText("기존 모델의 태그 전체를 덮어씁니다. 빈 값은 기존 내용을 지웁니다."),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole("cell", { name: "original-a" })).toBeInTheDocument();
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toHaveLength(0);
    await current.user.click(within(dialog).getByRole("checkbox"));
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toEqual([
      { model: modelA, good_for: "", avoid_for: "", risk_note: "" },
    ]);
  });
  it("최신 정상 빈 목록은 신규 추가를 허용", async () => {
    const current = await setup([]);
    await current.user.click(screen.getByRole("button", { name: "태그 추가" }));
    const dialog = screen.getByRole("dialog");
    await current.user.type(within(dialog).getByRole("textbox", { name: "모델" }), "new-model");
    await review(current, dialog);
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toHaveLength(1);
  });
  it("invalidate된 캐시는 저장을 차단하고 재조회 뒤 기준 변경은 초안 보존하며 재선택", async () => {
    const current = await setup();
    const dialog = await edit(current);
    await review(current, dialog);
    await act(async () => {
      await current.view.client.invalidateQueries({ queryKey: ["admin", "model-tags"], refetchType: "none" });
    });
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toHaveLength(0);
    current.records.set(modelA, row(modelA, "changed-on-server"));
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "최신 기준 다시 선택" })).toBeEnabled(),
    );
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toHaveLength(0);
    expect(within(dialog).getByRole("textbox", { name: "적합한 작업" })).toHaveValue("revised-a");
    await current.user.click(within(dialog).getByRole("button", { name: "최신 기준 다시 선택" }));
    await review(current, dialog);
    expect(within(dialog).getByRole("cell", { name: "changed-on-server" })).toBeInTheDocument();
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toHaveLength(1);
  });
  it("imported NEL ID는 수정 차단하되 정확히 인코딩한 원본 ID만 삭제", async () => {
    const id = "\u0085public/%한글?#";
    const current = await setup([row(id, "original-a"), row(modelA, "plain")]);
    const trigger = screen.getAllByRole("button", { name: "수정" })[0];
    if (!trigger) throw new Error("missing edit trigger");
    await current.user.click(trigger);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("textbox", { name: "모델" })).toHaveValue(id);
    expect(within(dialog).getByText(/이 모델 ID는 저장 시 다른 ID/)).toBeInTheDocument();
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toHaveLength(0);
    await current.user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    const deleteTrigger = screen.getAllByRole("button", { name: "삭제" })[0];
    if (!deleteTrigger) throw new Error("missing delete trigger");
    await current.user.click(deleteTrigger);
    const deletion = screen.getByRole("dialog");
    current.update("read_only");
    expect(within(deletion).getByRole("button", { name: "삭제" })).toBeDisabled();
    current.update("writable");
    await current.user.click(within(deletion).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(deletion).not.toBeInTheDocument());
    expect(current.api.calls.filter((call) => call.key.startsWith("DELETE"))).toHaveLength(1);
    expect(
      current.api.calls.some((call) => call.key === `DELETE /admin/model-tags/${encodeURIComponent(id)}`),
    ).toBe(true);
    expect(current.records.has(modelA)).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "태그 추가" })).toHaveFocus());
  });
  it("저장 성공 후 조회 실패는 1 POST 성공으로 남고 정확한 수정 트리거로 복귀", async () => {
    const current = await setup();
    const trigger = screen.getAllByRole("button", { name: "수정" })[0];
    const dialog = await edit(current);
    await review(current, dialog);
    current.response.read = () => {
      throw new AppError("조회 실패", { kind: "http", status: 500, requestId: "public-refresh-id" });
    };
    await nativeSubmit(dialog);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(current.api.bodies(savePath)).toHaveLength(1);
    expect(toast.success).toHaveBeenCalledWith("모델 용도 태그를 저장했습니다.");
    await screen.findByText("모델 용도 태그를 불러오지 못했습니다.");
    expect(toast.error).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("저장 대기 중 새 세션은 이전 응답의 알림·추가 갱신을 격리", async () => {
    const current = await setup();
    const dialog = await edit(current);
    await review(current, dialog);
    let release!: (value: ModelUsageTag) => void;
    current.response.save = () =>
      new Promise<ModelUsageTag>((resolve) => {
        release = resolve;
      });
    await nativeSubmit(dialog);
    expect(current.api.bodies(savePath)).toHaveLength(1);
    act(() => {
      tokenStore.clearAll();
      tokenStore.saveTokens({ access_token: "public-next", refresh_token: "public-next-refresh" });
    });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await screen.findByRole("table", { name: "모델별 용도 태그" });
    const reads = current.api.calls.filter((call) => call.key.startsWith("GET")).length;
    vi.mocked(toast.success).mockClear();
    await act(async () => {
      release(row(modelA, "late"));
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(current.api.calls.filter((call) => call.key.startsWith("GET"))).toHaveLength(reads);
  });
});
