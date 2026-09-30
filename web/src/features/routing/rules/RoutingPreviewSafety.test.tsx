import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { deferred, previewPath, previewResult, setupPreview } from "./routing-preview-test-harness";

describe("미리보기의 기존 순수 조회 정상 대조", () => {
  for (const mode of ["writable", "read_only", "preview_read_only"] as const) {
    it(`${mode}: routing:read만으로 실제 미리보기 버튼은 한 번 계산한다`, async () => {
      const current = await setupPreview(mode);
      current.fields("public-request-model", "샘플 A", "key_public_a");
      await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
      await screen.findByText("public-selected-model");
      expect(current.api.bodies(previewPath)).toEqual([
        {
          model: "public-request-model",
          messages: [{ role: "user", content: "샘플 A" }],
          api_key_id: "key_public_a",
        },
      ]);
      expect(current.api.calls.some(({ key }) => key === "POST /admin/cost/predict")).toBe(false);
    });
  }
  it("빈 모델은 실행 버튼을 잠그고 요청을 보내지 않는다", async () => {
    const current = await setupPreview();
    const button = screen.getByRole("button", { name: "미리보기 실행" });
    expect(button).toBeDisabled();
    await current.user.click(button);
    expect(current.api.bodies(previewPath)).toEqual([]);
  });
  it("503은 요청 ID를 표시하고 수동 재시도만 실행한다", async () => {
    const current = await setupPreview();
    current.fields();
    current.response.preview = () => {
      throw new AppError("synthetic failure", { kind: "http", status: 503, requestId: "req_preview_public" });
    };
    await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
    await screen.findByText(/req_preview_public/u);
    expect(current.api.bodies(previewPath)).toHaveLength(1);
    current.response.preview = () => previewResult;
    await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
    await screen.findByText("public-selected-model");
    expect(current.api.bodies(previewPath)).toHaveLength(2);
  });
});

describe("실행 기준 및 키 ID 전송 경계", () => {
  it("샘플 A를 보낸 뒤 B로 바꿔도 결과는 A의 기준이며 변경 안내로 구분한다", async () => {
    const current = await setupPreview();
    const held = deferred<typeof previewResult>();
    current.response.preview = () => held.promise;
    current.fields();
    await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
    expect(current.api.bodies(previewPath)).toEqual([
      { model: "public-request-model", messages: [{ role: "user", content: "샘플 A" }] },
    ]);
    current.fields("public-request-model", "샘플 B");
    await act(async () => {
      held.resolve(previewResult);
      await held.promise;
    });
    await screen.findByText("public-selected-model");
    expect(screen.getByRole("textbox", { name: "샘플 요청 내용" })).toHaveValue("샘플 B");
    expect(current.api.bodies(previewPath)).toHaveLength(1);
    expect(screen.getByText(/입력이 달라졌습니다/u)).toBeVisible();
  });
  for (const [name, secret, prefixes] of [
    ["기본 키 원문", `vc_sk_${"a".repeat(40)}`, ["vc_sk_", "vc_sa_"]],
    ["런타임 접두사", `custom_preview_${"b".repeat(40)}`, ["custom_preview_"]],
  ] as const) {
    it(`${name}: 실제 캡처한 실행 콜백도 키 ID 대신 비밀값을 전송하지 않는다`, async () => {
      const current = await setupPreview();
      current.update({ prefixes: [...prefixes] });
      expect(containsPotentialSecret(secret, prefixes)).toBe(true);
      current.fields("public-request-model", "샘플 A", secret);
      if (name === "기본 키 원문") expect(screen.getByText(secretSearchMessage)).toBeVisible();
      const callback = current.capture();
      await act(async () => {
        callback();
      });
      expect(current.api.bodies(previewPath)).toEqual([]);
    });
  }
});

describe("실제 콜백의 현재 권한·소유자·수명", () => {
  for (const change of ["read-scope", "owner", "epoch", "unmount"] as const) {
    it(`${change}: 이전 실행 콜백으로 새 요청을 보내지 않는다`, async () => {
      const current = await setupPreview();
      current.fields();
      const callback = current.capture();
      if (change === "read-scope") current.update({ scopes: [] });
      if (change === "owner") {
        current.update({ owner: "gateway.health" });
        expect(screen.getByTestId("preview-access")).toHaveTextContent("gateway.health:false");
      }
      if (change === "epoch") act(() => tokenStore.clearAll());
      if (change === "unmount") current.view.unmount();
      await act(async () => {
        callback();
      });
      expect(current.api.bodies(previewPath)).toEqual([]);
    });
  }
  it("렌더 전 동기 중복 콜백은 같은 미리보기를 한 번만 보낸다", async () => {
    const current = await setupPreview();
    current.fields();
    const held = deferred<typeof previewResult>();
    current.response.preview = () => held.promise;
    const callback = current.capture();
    act(() => {
      callback();
      callback();
    });
    const count = current.api.bodies(previewPath).length;
    await act(async () => {
      held.resolve(previewResult);
      await held.promise;
    });
    expect(count).toBe(1);
  });
  for (const result of ["resolve", "reject"] as const) {
    it(`세션 경계 뒤 이전 ${result}가 APIClient의 aborted로 정리돼도 새 UI 오류로 남지 않는다`, async () => {
      const current = await setupPreview();
      current.fields();
      const held = deferred<typeof previewResult>();
      current.response.preview = () => held.promise;
      await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
      expect(current.api.bodies(previewPath)).toHaveLength(1);
      act(() => tokenStore.clearAll());
      current.update({ userId: "preview-user-b" });
      await act(async () => {
        if (result === "resolve") held.resolve(previewResult);
        else held.reject(new AppError("late synthetic failure", { kind: "http", status: 503 }));
        await held.promise.catch(() => undefined);
      });
      await waitFor(() => expect(screen.queryByRole("button", { name: "확인 중" })).not.toBeInTheDocument());
      expect(screen.queryByText("public-selected-model")).not.toBeInTheDocument();
      expect(screen.queryByText("요청이 취소되었습니다.")).not.toBeInTheDocument();
      expect(current.api.bodies(previewPath)).toHaveLength(1);
    });
  }
});
