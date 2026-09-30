import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/shared/api/error";
import { initialRule, openToggle, patchPath, setupToggle } from "./routing-toggle-test-harness";

describe("라우팅 사용 전환 정상 대조", () => {
  for (const enabled of [true, false]) {
    it(`control: ${enabled ? "사용 중지" : "다시 사용"} 확인은 같은 ID에 enabled=${String(!enabled)} PATCH 1`, async () => {
      const current = await setupToggle(enabled);
      expect(
        screen.getByText(
          "사용 상태는 설정을 다시 읽은 서버에 반영되며, 실제 선택은 라우팅 활성 여부·조건·우선순위에 따릅니다.",
        ),
      ).toBeVisible();
      const opened = await openToggle(current, enabled);
      await current.user.click(
        within(opened.dialog).getByRole("button", { name: enabled ? "중지" : "사용" }),
      );
      await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
      expect(current.api.bodies(patchPath)).toEqual([{ enabled: !enabled }]);
      expect(current.records.get(initialRule.id)).toEqual({ ...initialRule, enabled: !enabled });
      expect(current.api.calls.filter((call) => !call.key.startsWith("GET"))).toHaveLength(1);
    });
  }

  it("control: 열기 전 routing:write가 없으면 사용 전환은 잠기고 PATCH 0", async () => {
    const current = await setupToggle(true, false);
    const trigger = screen.getByRole("button", { name: "gpt-* → public-model-a 규칙 중지" });
    expect(trigger).toBeDisabled();
    await current.user.click(trigger);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(current.api.bodies(patchPath)).toHaveLength(0);
  });

  it("control: 확인하지 않고 취소하면 상태 보존·PATCH 0", async () => {
    const current = await setupToggle();
    const opened = await openToggle(current);
    await current.user.click(within(opened.dialog).getByRole("button", { name: "취소" }));
    expect(opened.dialog).not.toBeInTheDocument();
    expect(current.records.get(initialRule.id)).toEqual(initialRule);
    expect(current.api.bodies(patchPath)).toHaveLength(0);
  });
});

describe("열린 사용 전환 확인의 현재 허가·목록 기준", () => {
  for (const mode of ["read_only", "preview_read_only"] as const) {
    it(`${mode}: 실제 FeatureRoute 전환 뒤 같은 확인창의 사용자 클릭은 PATCH 0`, async () => {
      const current = await setupToggle();
      const opened = await openToggle(current);
      current.update(mode);
      expect(screen.getByRole("dialog", { name: "라우팅 규칙 중지" })).toBe(opened.dialog);
      const confirmButton = within(opened.dialog).getByRole("button", { name: "중지" });
      const nativeClick = vi.fn();
      confirmButton.addEventListener("click", nativeClick);
      // Real user-event: no removal of disabled and no forced React handler call.
      await current.user.click(confirmButton);
      expect.soft(current.api.bodies(patchPath)).toHaveLength(0);
      expect.soft(nativeClick).toHaveBeenCalledTimes(0);
      expect(current.records.get(initialRule.id)).toEqual(initialRule);
    });
  }

  it("scope 회수: 이미 열린 확인창에서도 사용자 클릭은 PATCH 0", async () => {
    const current = await setupToggle();
    const opened = await openToggle(current);
    current.update("writable", false);
    expect(screen.getByRole("dialog", { name: "라우팅 규칙 중지" })).toBe(opened.dialog);
    await current.user.click(within(opened.dialog).getByRole("button", { name: "중지" }));
    expect(current.api.bodies(patchPath)).toHaveLength(0);
  });

  it("scope 회수: 렌더 시 캡처한 실제 onConfirm을 직접 호출해도 PATCH 0", async () => {
    const current = await setupToggle();
    const opened = await openToggle(current);
    current.update("writable", false);
    const invoke = vi.fn(() => opened.confirm(""));
    await act(async () => {
      await Promise.resolve()
        .then(invoke)
        .catch(() => undefined);
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(current.api.bodies(patchPath)).toHaveLength(0);
  });

  for (const change of ["changed", "deleted", "refetch-error"] as const) {
    it(`${change}: 확인 이후 최신 조회의 기준이 달라지거나 실패하면 PATCH 0`, async () => {
      const current = await setupToggle();
      const opened = await openToggle(current);
      if (change === "changed") {
        current.records.set(initialRule.id, { ...initialRule, target_model: "public-model-b" });
      } else if (change === "deleted") {
        current.records.delete(initialRule.id);
      } else {
        current.response.read = () => {
          throw new AppError("합성 조회 실패", {
            kind: "http",
            status: 503,
            requestId: "public-routing-503",
          });
        };
      }
      await current.refetch();
      const state = current.view.client.getQueryState(current.queryKey);
      expect(state?.status).toBe(change === "refetch-error" ? "error" : "success");
      if (change !== "refetch-error") {
        expect(current.view.client.getQueryData(current.queryKey)).toEqual({
          rules: [...current.records.values()],
        });
      }
      expect(screen.getByRole("dialog", { name: "라우팅 규칙 중지" })).toBe(opened.dialog);
      await current.user.click(within(opened.dialog).getByRole("button", { name: "중지" }));
      // A 404 after the synthetic deletion still counts as an attempted PATCH.
      // This tests UI admission, not server permission denial or atomic CAS.
      expect(current.api.bodies(patchPath)).toHaveLength(0);
    });
  }
});
