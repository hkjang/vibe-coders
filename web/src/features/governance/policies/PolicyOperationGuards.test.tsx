import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { deferred, savePath, setupEditor } from "./policy-editor-test-harness";

const casesPath = "POST /admin/policies/regression/cases";
const runPath = "POST /admin/policies/regression/run";
const removePath = "DELETE /admin/policies/regression/cases";
const sample = { id: "public-case", name: "공개 시나리오", model: "public-model", expect: "allow" };

describe("정책 생성과 회귀 작업의 현재 변경 권한", () => {
  it.each([
    ["정책 추가", "AI 정책 추가", "정책 이름", "정책 저장", savePath],
    ["시나리오 추가", "회귀 시나리오 추가", "시나리오 이름", "시나리오 저장", casesPath],
  ])(
    "열린 %s 폼은 읽기 전용 전환 시 초안을 보존하고 저장을 막는다",
    async (trigger, title, label, submit, path) => {
      const c = await setupEditor();
      await c.user.click(screen.getByRole("button", { name: trigger }));
      const dialog = screen.getByRole("dialog", { name: title });
      await c.user.type(within(dialog).getByRole("textbox", { name: label }), "보존할 공개 초안");
      c.update({ mode: "read_only" });
      expect(within(dialog).getByRole("textbox", { name: label })).toHaveValue("보존할 공개 초안");
      expect(within(dialog).getByRole("button", { name: submit })).toBeDisabled();
      await c.user.click(within(dialog).getByRole("button", { name: submit }));
      expect(c.api.bodies(path)).toEqual([]);
    },
  );
  it.each(["read_only", "preview_read_only"])("%s에서는 신규 진입과 회귀 실행을 차단한다", async (mode) => {
    const c = await setupEditor();
    c.update({ mode });
    for (const name of ["정책 추가", "시나리오 추가", "전체 회귀 실행"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
  });
  it("권한 전환 이전 실행 콜백도 현재 읽기 전용 상태를 우회하지 못한다", async () => {
    const c = await setupEditor();
    const old = c.captureRun();
    c.update({ mode: "read_only" });
    await act(async () => old());
    expect(c.api.bodies(runPath)).toEqual([]);
  });
  it("같은 렌더의 반복 실행 콜백은 API를 한 번만 호출한다", async () => {
    const c = await setupEditor();
    const held = deferred<unknown>();
    c.response.run = () => held.promise;
    const run = c.captureRun();
    await act(async () => {
      run();
      run();
    });
    expect(c.api.bodies(runPath)).toHaveLength(1);
    expect(screen.getByRole("button", { name: "전체 회귀 실행" })).toBeDisabled();
    await act(async () => held.resolve({ passed: 1, failed: 0 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "전체 회귀 실행" })).toBeEnabled());
    const call = c.api.spy.mock.calls.find(([endpoint]) => `${endpoint.method} ${endpoint.path}` === runPath);
    expect(call?.[1]).toMatchObject({ retryUnauthorized: false });
  });
  it.each(["scope", "principal", "unmount"])(
    "%s 변경 후 이전 실행 콜백은 전송하지 않는다",
    async (boundary) => {
      const c = await setupEditor();
      const run = c.captureRun();
      if (boundary === "scope") c.update({ scopes: ["security:read", "admin:read"] });
      if (boundary === "principal") c.update({ principal: "another-reader" });
      if (boundary === "unmount") c.view.unmount();
      await act(async () => run());
      expect(c.api.bodies(runPath)).toEqual([]);
    },
  );
  it.each([
    ["정책 추가", "AI 정책 추가", "정책 이름", "정책 저장", savePath],
    ["시나리오 추가", "회귀 시나리오 추가", "시나리오 이름", "시나리오 저장", casesPath],
  ])(
    "%s 권한 복구 후에는 명시 저장만 수행하고 인증 재전송은 금지한다",
    async (trigger, title, label, submit, path) => {
      const c = await setupEditor();
      c.response.save = () => ({ policy: { id: "public-created" } });
      await c.user.click(screen.getByRole("button", { name: trigger }));
      const dialog = screen.getByRole("dialog", { name: title });
      await c.user.type(within(dialog).getByRole("textbox", { name: label }), "공개 새 항목");
      c.update({ scopes: ["security:read", "admin:read"] });
      expect(within(dialog).getByRole("button", { name: submit })).toBeDisabled();
      c.update({ scopes: ["security:read", "admin:read", "admin:write"] });
      expect(c.api.bodies(path)).toEqual([]);
      await c.user.click(within(dialog).getByRole("button", { name: submit }));
      await waitFor(() => expect(c.api.bodies(path)).toHaveLength(1));
      expect(c.api.bodies(path)[0]).toMatchObject({ name: "공개 새 항목" });
      const call = c.api.spy.mock.calls.find(([endpoint]) => `${endpoint.method} ${endpoint.path}` === path);
      expect(call?.[1]).toMatchObject({ retryUnauthorized: false });
    },
  );
  it("닫힌 삭제 검토의 콜백은 같은 시나리오를 다시 열어도 재사용하지 않는다", async () => {
    const c = await setupEditor();
    c.response.cases = () => ({ cases: [sample] });
    await act(async () => c.view.client.refetchQueries({ queryKey: ["governance", "regression-cases"] }));
    await c.user.click(await screen.findByRole("button", { name: `${sample.name} 시나리오 삭제` }));
    const old = c.captureDelete();
    await c.user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "취소" }));
    await c.user.click(screen.getByRole("button", { name: `${sample.name} 시나리오 삭제` }));
    await act(async () => {
      await expect(old()).rejects.toBeDefined();
    });
    expect(c.api.bodies(removePath)).toEqual([]);
    await c.user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(c.api.bodies(removePath)).toHaveLength(1));
    const call = c.api.spy.mock.calls.find(([endpoint]) => endpoint.method === "DELETE");
    expect(call?.[1]).toMatchObject({ retryUnauthorized: false, query: { id: sample.id } });
  });
  it.each(["readonly", "changed"])("삭제 검토는 %s 이후 전송하지 않는다", async (change) => {
    const c = await setupEditor();
    c.response.cases = () => ({ cases: [sample] });
    await act(async () => c.view.client.refetchQueries({ queryKey: ["governance", "regression-cases"] }));
    await c.user.click(await screen.findByRole("button", { name: `${sample.name} 시나리오 삭제` }));
    const dialog = screen.getByRole("dialog", { name: "회귀 시나리오를 삭제할까요?" });
    if (change === "readonly") c.update({ mode: "read_only" });
    else {
      c.response.cases = () => ({ cases: [{ ...sample, expect: "block" }] });
      await act(async () => c.view.client.refetchQueries({ queryKey: ["governance", "regression-cases"] }));
    }
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "삭제" })).toBeDisabled());
    expect(c.api.bodies(removePath)).toEqual([]);
  });
});
