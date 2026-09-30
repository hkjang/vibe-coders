import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { hiddenPreviewValue, previewTier } from "./routing-preview-state";
import { deferred, previewPath, previewResult, setupPreview } from "./routing-preview-test-harness";

function previewCard() {
  const card = screen.getByRole("heading", { name: "라우팅 미리보기" }).closest("section");
  if (!card) throw new Error("missing preview card");
  return card as HTMLElement;
}

describe("실행 당시 입력과 수동 재계산", () => {
  for (const field of ["model", "key", "sample"] as const) {
    it(`${field} A→B 변경은 A의 메모리 기준과 구분하고 수동 실행만 B를 보낸다`, async () => {
      const current = await setupPreview();
      const held = deferred<typeof previewResult>();
      current.response.preview = () => held.promise;
      current.fields("request-a", "공개 합성 샘플 A", "key_public_a");
      await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
      const next = {
        model: field === "model" ? "request-b" : "request-a",
        key: field === "key" ? "key_public_b" : "key_public_a",
        sample: field === "sample" ? "공개 합성 샘플 B" : "공개 합성 샘플 A",
      };
      current.fields(next.model, next.sample, next.key);
      expect(screen.getByText(/입력이 달라졌습니다/u)).toBeVisible();
      expect(screen.queryByText("아직 미리보기를 실행하지 않았습니다.")).not.toBeInTheDocument();
      await act(async () => held.resolve(previewResult));
      await screen.findByText("현재 설정의 예상 계획");
      expect(current.api.bodies(previewPath)).toEqual([
        {
          model: "request-a",
          api_key_id: "key_public_a",
          messages: [{ role: "user", content: "공개 합성 샘플 A" }],
        },
      ]);
      // The sample exists only in the controlled input and admission snapshot,
      // not in new result/metadata text, browser URL or persistent storage.
      const staticText = [...previewCard().querySelectorAll("dl, .inline-notice")]
        .map((node) => node.textContent)
        .join(" ");
      expect(staticText).not.toContain("공개 합성 샘플 A");
      expect(staticText).not.toContain("공개 합성 샘플 B");
      expect(window.location.href).not.toContain(encodeURIComponent("공개 합성 샘플"));
      expect(JSON.stringify(localStorage)).not.toContain("공개 합성 샘플");
      expect(JSON.stringify(sessionStorage)).not.toContain("공개 합성 샘플");
      current.response.preview = () => ({ ...previewResult, selected_model: "selected-b" });
      await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
      await screen.findByText("selected-b");
      expect(current.api.bodies(previewPath)[1]).toEqual({
        model: next.model,
        api_key_id: next.key,
        messages: [{ role: "user", content: next.sample }],
      });
      expect(screen.queryByText(/입력이 달라졌습니다/u)).not.toBeInTheDocument();
    });
  }

  it("기존 wire trim을 유지하되 원문 샘플은 변경하지 않는다", async () => {
    const current = await setupPreview();
    current.fields("  request-a  ", "  공개 샘플\n  ", "  key_public_a  ");
    await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
    await screen.findByText("현재 설정의 예상 계획");
    expect(current.api.bodies(previewPath)).toEqual([
      {
        model: "request-a",
        api_key_id: "key_public_a",
        messages: [{ role: "user", content: "  공개 샘플\n  " }],
      },
    ]);
  });

  it("오류 상태는 아직 실행하지 않았다는 빈 상태나 예전 성공과 혼합하지 않는다", async () => {
    const current = await setupPreview();
    current.fields();
    await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
    await screen.findByText("public-selected-model");
    current.response.preview = () => {
      throw new AppError("synthetic", { kind: "network" });
    };
    await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
    await screen.findByText("미리보기를 실행하지 못했습니다.");
    expect(screen.queryByText("public-selected-model")).not.toBeInTheDocument();
    expect(screen.queryByText("아직 미리보기를 실행하지 않았습니다.")).not.toBeInTheDocument();
    expect(screen.queryByText("미리보기 계산 중")).not.toBeInTheDocument();
  });

  for (const mode of ["read_only", "preview_read_only"] as const) {
    it(`${mode} 전환은 이미 보낸 순수 미리보기와 이후 수동 계산을 막지 않는다`, async () => {
      const current = await setupPreview();
      const held = deferred<typeof previewResult>();
      current.response.preview = () => held.promise;
      current.fields();
      await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
      current.update({ mode });
      expect(screen.getByTestId("preview-access")).toHaveTextContent("routing.rules:true");
      await act(async () => held.resolve(previewResult));
      await screen.findByText("public-selected-model");
      expect(screen.getByRole("textbox", { name: "샘플 요청 내용" })).toHaveValue("샘플 A");
      current.response.preview = () => previewResult;
      await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
      expect(current.api.bodies(previewPath)).toHaveLength(2);
    });
  }
});

describe("계산 결과의 표시 전용 민감정보 보호", () => {
  it("서버의 알려진 복잡도·위험 등급만 한글로 표시하고 미지의 값은 안전 검사 후 유지한다", () => {
    for (const [value, label] of [
      ["simple", "단순"],
      ["standard", "일반"],
      ["complex", "복잡"],
      ["reasoning", "추론"],
      ["low", "낮음"],
      ["medium", "중간"],
      ["high", "높음"],
      ["critical", "매우 높음"],
      ["future-tier", "future-tier"],
    ])
      expect(previewTier(value, [])).toBe(label);
  });

  it("서버에서 가려진 정상 requested_model은 입력과 달라도 성공으로 표시한다", async () => {
    const current = await setupPreview();
    current.response.preview = () => ({ ...previewResult, requested_model: "[redacted]" });
    current.fields("request-with-limited-view");
    await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
    await screen.findByText("public-selected-model");
    expect(screen.getByText("[redacted]")).toBeVisible();
    expect(screen.getByText("request-with-limited-view")).toBeVisible();
    expect(screen.queryByText("미리보기를 실행하지 못했습니다.")).not.toBeInTheDocument();
  });

  it("모든 동적 결과 문자열과 재작성 설명은 현재 접두사로 가리고 원문 DOM 속성에 넣지 않는다", async () => {
    const current = await setupPreview();
    current.update({ prefixes: ["preview_result_"] });
    const secret = `preview_result_${"r".repeat(40)}`;
    current.response.preview = () => ({
      ...previewResult,
      requested_model: secret,
      selected_model: secret,
      selected_provider: secret,
      policy_api_key_id: secret,
      route_reason: secret,
      decision_reason: secret,
      complexity: { score: 10, tier: secret },
      risk: { score: 0, tier: secret, categories: [] },
      fallback_plan: [secret],
      would_rewrite: true,
    });
    current.fields();
    await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
    await screen.findByText("요청 모델을 바꾸는 계획입니다.");
    expect(previewCard().outerHTML).not.toContain(secret);
    expect(within(previewCard()).getAllByText(hiddenPreviewValue).length).toBeGreaterThanOrEqual(7);
    expect(current.api.bodies(previewPath)).toHaveLength(1);
  });

  it("현재 접두사 갱신은 기존 결과와 메모리 스냅숏 표시에도 적용되며 요청을 다시 보내지 않는다", async () => {
    const current = await setupPreview();
    const futureSecret = `new_result_${"n".repeat(40)}`;
    current.fields(futureSecret, "샘플 A", futureSecret);
    current.response.preview = () => ({ ...previewResult, selected_model: futureSecret });
    await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
    await screen.findByText("현재 설정의 예상 계획");
    current.update({ prefixes: ["new_result_"] });
    expect(within(previewCard()).getAllByText(hiddenPreviewValue)).toHaveLength(3);
    for (const node of previewCard().querySelectorAll("dl"))
      expect(node.textContent).not.toContain(futureSecret);
    expect(current.api.bodies(previewPath)).toHaveLength(1);
  });

  it("입력 직후 접두사가 변경되어도 이전 실행 콜백은 최신 접두사로 전송을 막는다", async () => {
    const current = await setupPreview();
    current.fields("public-request-model", "샘플 A", `new_key_${"k".repeat(40)}`);
    const callback = current.capture();
    current.update({ prefixes: ["new_key_"] });
    await act(async () => callback());
    expect(current.api.bodies(previewPath)).toHaveLength(0);
  });

  it("퍼센트 인코딩된 키 원문도 캡처 콜백에서 전송하지 않는다", async () => {
    const current = await setupPreview();
    const encoded = [...`vc_sk_${"e".repeat(40)}`]
      .map((character) => `%${character.charCodeAt(0).toString(16)}`)
      .join("");
    current.fields("public-request-model", "샘플 A", encoded);
    expect(screen.getByRole("button", { name: "미리보기 실행" })).toBeDisabled();
    await act(async () => current.capture()());
    expect(current.api.bodies(previewPath)).toHaveLength(0);
  });

  it("동적 Request ID는 현재 표시 정책으로 가리며 서버 오류 원문은 표시하지 않는다", async () => {
    const current = await setupPreview();
    const secret = `vc_sk_${"i".repeat(40)}`;
    current.fields();
    current.response.preview = () => {
      throw new AppError(`synthetic raw body ${secret}`, { kind: "http", status: 503, requestId: secret });
    };
    await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
    await screen.findByText("미리보기를 실행하지 못했습니다.");
    expect(previewCard().outerHTML).not.toContain(secret);
    expect(screen.getByText(new RegExp(`요청 ID: ${hiddenPreviewValue}`, "u"))).toBeVisible();
  });
});

describe("이전 완료와 새 비행의 실제 제어 Promise 겹침", () => {
  for (const settle of ["resolve", "reject"] as const) {
    it(`이전 ${settle}/finally는 이미 진행 중인 새 세션 계산을 끝내거나 덮지 않는다`, async () => {
      const current = await setupPreview();
      const old = deferred<typeof previewResult>();
      const next = deferred<typeof previewResult>();
      let count = 0;
      current.response.preview = () => (++count === 1 ? old.promise : next.promise);
      current.fields("request-a", "이전 공개 샘플 A");
      await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
      act(() => tokenStore.clearAll());
      current.update({ userId: "preview-user-b" });
      expect(screen.getByRole("textbox", { name: "샘플 요청 내용" })).toHaveValue("");
      current.fields("request-b", "새 공개 샘플 B");
      await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
      expect(current.api.bodies(previewPath)).toHaveLength(2);
      await act(async () => {
        if (settle === "resolve") old.resolve({ ...previewResult, selected_model: "old-selected-a" });
        else old.reject(new AppError("old synthetic", { kind: "http", status: 503 }));
        await old.promise.catch(() => undefined);
      });
      expect(screen.getByRole("button", { name: "확인 중" })).toBeDisabled();
      expect(screen.getByText("미리보기 계산 중")).toBeVisible();
      expect(screen.queryByText("old-selected-a")).not.toBeInTheDocument();
      expect(screen.queryByText("미리보기를 실행하지 못했습니다.")).not.toBeInTheDocument();
      const duplicate = current.capture();
      await act(async () => duplicate());
      expect(current.api.bodies(previewPath)).toHaveLength(2);
      await act(async () => next.resolve({ ...previewResult, selected_model: "new-selected-b" }));
      await screen.findByText("new-selected-b");
      expect(screen.getByRole("textbox", { name: "샘플 요청 내용" })).toHaveValue("새 공개 샘플 B");
    });
  }

  for (const change of ["read", "owner", "unmount"] as const) {
    it(`${change} 철회 후 이미 보낸 응답은 결과를 게시하거나 새 요청을 보내지 않는다`, async () => {
      const current = await setupPreview();
      const held = deferred<typeof previewResult>();
      current.response.preview = () => held.promise;
      current.fields();
      await current.user.click(screen.getByRole("button", { name: "미리보기 실행" }));
      if (change === "read") current.update({ scopes: [] });
      if (change === "owner") current.update({ owner: "gateway.health" });
      if (change === "unmount") current.view.unmount();
      await act(async () => held.resolve(previewResult));
      expect(screen.queryByText("public-selected-model")).not.toBeInTheDocument();
      expect(screen.queryByText("미리보기를 실행하지 못했습니다.")).not.toBeInTheDocument();
      expect(current.api.bodies(previewPath)).toHaveLength(1);
    });
  }
});
