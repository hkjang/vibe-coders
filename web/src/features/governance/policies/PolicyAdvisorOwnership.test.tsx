import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { deferred, setupDraft } from "./policy-draft-test-harness";

const policy = { id: "public-policy", name: "공개 정책", enabled: true, rollout_percent: 25, rules: [] };
const savePath = "POST /admin/policies";
async function setup() {
  const c = await setupDraft();
  c.response.policies = () => ({ policies: [policy] });
  c.response.canary = () => ({
    policies: [{ policy_id: policy.id, name: policy.name, rollout_percent: 25, suggested_next: 50 }],
  });
  await act(async () => {
    await c.view.client.refetchQueries({ queryKey: ["governance", "policies"] });
    await c.view.client.refetchQueries({ queryKey: ["governance", "canary"] });
  });
  const trigger = await screen.findByRole("button", { name: `${policy.name} 적용 비율 상향` });
  await waitFor(() => expect(trigger).toBeEnabled());
  const open = async () => {
    await c.user.click(trigger);
    return screen.getByRole("dialog", { name: /적용 비율을 상향할까요/u });
  };
  return { ...c, trigger, open };
}

describe("정책 추천의 현재 조회 소유자", () => {
  it.each(["principal", "session"])("%s 전환은 이전 검토와 적용 근거를 폐기한다", async (boundary) => {
    const c = await setup();
    await c.open();
    const held = deferred<unknown>();
    c.response.policies = c.response.canary = c.response.suggestions = () => held.promise;
    if (boundary === "principal") c.update({ principal: "public-reader-b" });
    else act(() => tokenStore.clearAll());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByText(policy.name)).not.toBeInTheDocument();
    await act(async () => held.resolve({ policies: [], suggestions: [] }));
    expect(c.api.bodies(savePath)).toEqual([]);
  });
  it.each(["changed", "denied", "readonly"])("%s 상태에서는 열린 검토를 전송하지 않는다", async (state) => {
    const c = await setup();
    const dialog = await c.open();
    if (state === "readonly") c.update({ mode: "read_only" });
    else {
      c.response.policies = () => {
        if (state === "denied") throw new AppError("private", { kind: "http", status: 403 });
        return { policies: [{ ...policy, name: "바뀐 정책" }] };
      };
      await act(async () => c.view.client.refetchQueries({ queryKey: ["governance", "policies"] }));
    }
    const confirm = within(dialog).getByRole("button", { name: "상향" });
    await waitFor(() => expect(confirm).toBeDisabled());
    await c.user.click(confirm);
    expect(c.api.bodies(savePath)).toEqual([]);
  });
  it("현재 조회 정책만 한 번 전송하고 자동 인증 재전송을 금지한다", async () => {
    const c = await setup();
    const dialog = await c.open();
    await c.user.click(within(dialog).getByRole("button", { name: "상향" }));
    await waitFor(() => expect(c.api.bodies(savePath)).toHaveLength(1));
    expect(c.api.bodies(savePath)[0]).toMatchObject({ id: policy.id, rollout_percent: 50 });
    const call = c.api.spy.mock.calls.find(
      ([endpoint]) => endpoint.path === "/admin/policies" && endpoint.method === "POST",
    );
    expect(call?.[1]).toMatchObject({ retryUnauthorized: false });
  });
  it("이전 계정의 저장 완료는 새 계정의 정책 조회와 캐시를 갱신하지 않는다", async () => {
    const c = await setup();
    const held = deferred<unknown>();
    c.response.save = () => held.promise;
    const dialog = await c.open();
    await c.user.click(within(dialog).getByRole("button", { name: "상향" }));
    await waitFor(() => expect(c.api.bodies(savePath)).toHaveLength(1));
    c.response.policies = () => ({ policies: [{ ...policy, name: "새 계정 정책" }] });
    c.update({ principal: "public-reader-b" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: `${policy.name} 적용 비율 상향` })).toBeEnabled(),
    );
    const before = c.api.calls.length;
    await act(async () => held.resolve({}));
    expect(c.api.calls).toHaveLength(before);
    expect(screen.queryByText("단계 적용 비율을 상향했습니다.")).not.toBeInTheDocument();
  });
  it("응답이 불명확한 변경은 같은 확인창에서 다시 전송하지 않는다", async () => {
    const c = await setup();
    c.response.save = () => {
      throw new AppError("private", { kind: "network" });
    };
    const dialog = await c.open();
    await c.user.click(within(dialog).getByRole("button", { name: "상향" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "상향" })).toBeDisabled());
    expect(c.api.bodies(savePath)).toHaveLength(1);
    await c.user.click(within(dialog).getByRole("button", { name: "상향" }));
    expect(c.api.bodies(savePath)).toHaveLength(1);
  });
});
