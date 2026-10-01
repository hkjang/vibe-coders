import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { acknowledgement, applyPath, deferred, setupDraft } from "./policy-draft-test-harness";

describe("닫힌 A 검토의 콜백과 조회가 새 B를 소유하지 않는다", () => {
  it("과거 A 취소 callback은 새 B 검토를 닫지 않는다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    const old = c.capture("close");
    await c.user.click(within(c.dialog()).getByRole("button", { name: "취소" }));
    await c.user.click(c.button());
    await act(async () => old());
    expect(c.dialog()).toBeVisible();
    expect(c.api.bodies(applyPath)).toEqual([]);
  });
  it("과거 A 재확인 callback은 재확인이 필요한 새 B를 승인하지 않는다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    c.update({ mode: "read_only" });
    c.update({ mode: "writable" });
    const old = c.capture("review");
    await c.user.click(within(c.dialog()).getByRole("button", { name: "취소" }));
    await c.user.click(c.button());
    c.update({ mode: "read_only" });
    c.update({ mode: "writable" });
    expect(c.confirm()).toBeDisabled();
    await act(async () => old());
    expect(c.confirm()).toBeDisabled();
    expect(c.api.bodies(applyPath)).toEqual([]);
  });
  it("과거 A 목록조회 callback은 새 B에서 GET을 시작하지 않는다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    c.update({ mode: "read_only" });
    c.update({ mode: "writable" });
    const old = c.capture("refresh");
    await c.user.click(within(c.dialog()).getByRole("button", { name: "취소" }));
    await c.user.click(c.button());
    const before = c.api.calls.filter(({ key }) => key === "GET /admin/policy-advisor/suggestions").length;
    await act(async () => old());
    expect(c.api.calls.filter(({ key }) => key === "GET /admin/policy-advisor/suggestions")).toHaveLength(
      before,
    );
  });
  it("수동 목록 조회 중 취소해도 같은 기간의 행을 영구 잠그지 않는다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    c.update({ mode: "read_only" });
    c.update({ mode: "writable" });
    const held = deferred<unknown>();
    c.response.suggestions = () => held.promise;
    await c.user.click(within(c.dialog()).getByRole("button", { name: "목록 다시 조회" }));
    await c.user.click(within(c.dialog()).getByRole("button", { name: "취소" }));
    await act(async () => held.reject(new Error("public aborted query")));
    expect(c.button()).toBeEnabled();
    await c.user.click(c.button());
    expect(c.dialog()).toBeVisible();
    expect(c.api.bodies(applyPath)).toEqual([]);
  });
  it("A의 취소된 후속 GET이 미완료여도 B 생성 뒤 독립 조회를 한다", async () => {
    const c = await setupDraft();
    const a = deferred<unknown>();
    const b = deferred<unknown>();
    let reads = 0;
    c.response.policies = () => (++reads === 1 ? a.promise : b.promise);
    await c.user.click(c.button());
    await c.user.click(c.confirm());
    await screen.findByText("비활성 정책 초안을 생성했습니다.");
    expect(reads).toBe(1);
    await c.user.click(screen.getByRole("button", { name: "닫기" }));
    await c.user.click(c.button());
    await c.user.click(c.confirm());
    await screen.findByText("비활성 정책 초안을 생성했습니다.");
    await waitFor(() => expect(reads).toBe(2));
    await act(async () => a.reject(new Error("public old lookup error")));
    expect(screen.queryByText(/생성은 확인했지만 정책 목록을 갱신하지 못했습니다/u)).not.toBeInTheDocument();
    await act(async () => b.resolve({ policies: [] }));
    expect(c.api.bodies(applyPath)).toHaveLength(2);
    expect(acknowledgement.enabled).toBe(false);
  });
  it("목록 읽기 권한을 잃은 응답은 게시하지 않고 자기 조회 잠금만 해제한다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    c.update({ mode: "read_only" });
    c.update({ mode: "writable" });
    const held = deferred<unknown>();
    c.response.suggestions = () => held.promise;
    const refresh = () => within(c.dialog()).getByRole("button", { name: "목록 다시 조회" });
    await c.user.click(refresh());
    c.update({ scopes: ["security:read", "admin:write"] });
    await act(async () =>
      held.resolve({ suggestions: [{ ...c.response.rows[0], title: "게시하면 안 되는 응답" }] }),
    );
    c.update({ scopes: ["security:read", "admin:read", "admin:write"] });
    expect(refresh()).toBeEnabled();
    expect(screen.queryByText("게시하면 안 되는 응답")).not.toBeInTheDocument();
    expect(c.confirm()).toBeDisabled();
    expect(c.api.bodies(applyPath)).toEqual([]);
  });
  it("A에서 대기하던 조회를 취소하고 B를 거쳐 A로 돌아와도 잠금이 되살아나지 않는다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    c.update({ mode: "read_only" });
    const held = deferred<unknown>();
    let calls = 0;
    c.response.suggestions = () =>
      ++calls === 1 ? held.promise : { suggestions: structuredClone(c.response.rows) };
    const refresh = () => within(c.dialog()).getByRole("button", { name: "목록 다시 조회" });
    await c.user.click(refresh());
    expect(refresh()).toBeDisabled();
    c.changeWindow("30d");
    await waitFor(() => expect(calls).toBe(2));
    c.changeWindow("7d");
    await waitFor(() => expect(calls).toBe(3));
    await act(async () => held.reject(new Error("public old A response")));
    expect(refresh()).toBeEnabled();
    expect(c.dialog()).not.toHaveTextContent("추천 목록을 갱신하지 못했습니다.");
    c.update({ mode: "writable" });
    await c.user.click(within(c.dialog()).getByRole("button", { name: "원래 규칙 다시 확인" }));
    expect(c.confirm()).toBeEnabled();
    expect(c.api.bodies(applyPath)).toEqual([]);
  });
});
