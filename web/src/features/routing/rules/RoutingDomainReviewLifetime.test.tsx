import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { tokenStore } from "@/shared/auth/token-store";
import {
  deferred,
  domainToasts,
  reviewPath,
  reviewRow,
  setupDomainReview,
} from "./domain-review-test-harness";

const invoke = async (callback: () => unknown) => {
  await act(async () => {
    await callback();
  });
};
type Current = Awaited<ReturnType<typeof setupDomainReview>>;
async function ready(current: Current) {
  await waitFor(() => {
    expect(current.actualQuery().state.status).toBe("success");
    expect(current.actualQuery().state.fetchStatus).toBe("idle");
  });
}
async function record(current: Current) {
  const opened = await current.open();
  await current.user.click(opened.confirm);
  await waitFor(() => expect(domainToasts().success).toHaveBeenCalledTimes(1));
  expect(current.writes()).toHaveLength(1);
}

describe("검토 권한과 주체의 수명", () => {
  it.each([
    ["쓰기 권한", { scopes: ["routing:read"] }, { scopes: ["routing:read", "routing:write"] }],
    ["읽기 권한", { scopes: ["routing:write"] }, { scopes: ["routing:read", "routing:write"] }],
    ["읽기 전용", { readOnly: true }, { readOnly: false }],
    ["원문 조회", { raw: false }, { raw: true }],
    ["계정", { user: "another-user" }, { user: "public-user" }],
    ["팀", { team: "another-team" }, { team: "public-team" }],
    ["역할", { role: "security_admin" }, { role: "admin" }],
    ["표시 보호", { prefixes: ["private_public_"] }, { prefixes: ["vc_sk_", "vc_sa_"] }],
  ])("%s A→B→A는 옛 창과 콜백을 복원하지 않는다", async (_name, next, restore) => {
    const current = await setupDomainReview(),
      original = current.actualQuery();
    const opened = await current.open(),
      oldSave = current.capture(opened.label);
    const oldRefresh = current.capture("검토 목록 다시 조회");
    current.update(next);
    await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
    current.update(restore);
    await ready(current);
    expect(current.actualQuery()).not.toBe(original);
    expect(current.view.client.getQueryCache().getAll()).not.toContain(original);
    const reads = current.calls.filter((call) => call.key === reviewPath).length;
    await invoke(oldSave);
    await invoke(oldRefresh);
    expect(current.writes()).toHaveLength(0);
    expect(current.calls.filter((call) => call.key === reviewPath)).toHaveLength(reads);
    await record(current);
  });

  it("세션 변경은 현재 주체가 같아도 옛 동의를 폐기한다", async () => {
    const current = await setupDomainReview(),
      opened = await current.open();
    const oldSave = current.capture(opened.label);
    act(() => tokenStore.clearAll());
    await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
    await ready(current);
    await invoke(oldSave);
    expect(current.writes()).toHaveLength(0);
    await record(current);
  });

  it("원문 권한 회수는 기존 성공 캐시와 화면을 제거하고 새 조회하지 않는다", async () => {
    const current = await setupDomainReview(),
      original = current.actualQuery();
    const reads = current.calls.filter((call) => call.key === reviewPath).length;
    current.update({ raw: false });
    expect(screen.queryByRole("table", { name: "도메인 라우팅 검토 큐" })).not.toBeInTheDocument();
    expect(current.view.client.getQueryCache().getAll()).not.toContain(original);
    expect(current.calls.filter((call) => call.key === reviewPath)).toHaveLength(reads);
    expect(screen.getByText("도메인 검토 조회 권한을 확인하세요.")).toBeInTheDocument();
  });

  it("이전 주체의 늦은 GET은 새 주체의 현재 조회를 덮어쓰지 않는다", async () => {
    const current = await setupDomainReview(),
      original = current.actualQuery();
    const held = deferred<unknown>();
    current.response.review = () => held.promise;
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = original.fetch().catch(() => undefined);
    });
    expect(original.state.fetchStatus).toBe("fetching");
    current.response.review = undefined;
    current.update({ user: "another-user" });
    await ready(current);
    current.update({ user: "public-user" });
    await ready(current);
    const latest = current.actualQuery(),
      before = latest.state.data;
    await act(async () => {
      held.resolve({ items: [{ ...reviewRow, reason: "RETIRED-REASON-CANARY" }] });
      await pending;
    });
    expect(current.actualQuery()).toBe(latest);
    expect(latest.state.data).toBe(before);
    expect(screen.queryByText("RETIRED-REASON-CANARY")).not.toBeInTheDocument();
    await record(current);
  });

  it("이전 주체의 늦은 ACK는 성공 알림과 후속 GET을 발생시키지 않는다", async () => {
    const current = await setupDomainReview(),
      opened = await current.open();
    const held = deferred<unknown>();
    current.response.action = () => held.promise;
    await current.user.click(opened.confirm);
    expect(current.writes()).toHaveLength(1);
    current.update({ user: "another-user" });
    await ready(current);
    const reads = current.calls.filter((call) => call.key === reviewPath).length;
    await act(async () => {
      held.resolve({ id: reviewRow.id, status: "approved" });
      await Promise.resolve();
    });
    expect(domainToasts().success).not.toHaveBeenCalled();
    expect(current.calls.filter((call) => call.key === reviewPath)).toHaveLength(reads);
    expect(opened.dialog).not.toBeInTheDocument();
  });
});

describe("실제 Query와 동의의 수명", () => {
  it("동의 전의 보관된 최종 콜백도 상태를 기록하지 않는다", async () => {
    const current = await setupDomainReview(),
      opened = await current.open("approve", false);
    expect(opened.confirm).toHaveAttribute("aria-disabled", "true");
    await invoke(current.capture(opened.label));
    expect(current.writes()).toHaveLength(0);
  });

  it("새 GET은 같은 내용이어도 명시적인 재검토와 새 동의가 필요하다", async () => {
    const current = await setupDomainReview(),
      opened = await current.open();
    const oldSave = current.capture(opened.label);
    await act(async () => {
      await current.actualQuery().fetch();
    });
    await invoke(oldSave);
    expect(current.writes()).toHaveLength(0);
    expect(within(opened.dialog).getByRole("checkbox")).not.toBeChecked();
    await current.user.click(within(opened.dialog).getByRole("button", { name: "기록할 상태 다시 검토" }));
    expect(within(opened.dialog).getByRole("checkbox")).not.toBeChecked();
    await current.user.click(within(opened.dialog).getByRole("checkbox"));
    await current.user.click(opened.confirm);
    await waitFor(() => expect(domainToasts().success).toHaveBeenCalledTimes(1));
    expect(current.writes()).toHaveLength(1);
  });

  it("취소된 GET이 데이터와 갱신 횟수를 복구해도 옛 동의는 복구하지 않는다", async () => {
    const current = await setupDomainReview(),
      opened = await current.open();
    const oldSave = current.capture(opened.label),
      query = current.actualQuery();
    const data = query.state.data,
      count = query.state.dataUpdateCount,
      held = deferred<unknown>();
    current.response.review = () => held.promise;
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = query.fetch().catch(() => undefined);
    });
    await act(async () => {
      await current.view.client.cancelQueries({ queryKey: query.queryKey, exact: true });
    });
    expect(query.state.data).toBe(data);
    expect(query.state.dataUpdateCount).toBe(count);
    expect(query.state.fetchStatus).toBe("idle");
    await invoke(oldSave);
    expect(current.writes()).toHaveLength(0);
    await act(async () => {
      held.resolve({ items: [{ ...reviewRow }] });
      await pending;
    });
  });

  it.each([
    "reason",
    "current_route",
    "suggested_route",
    "decision_id",
    "created_at",
    "reviewed_at",
  ] as const)("%s 변경은 원래 검토의 다른 내용을 재승인하지 않는다", async (field) => {
    const current = await setupDomainReview(),
      opened = await current.open();
    current.response.review = () => ({ items: [{ ...reviewRow, [field]: "CHANGED-METADATA" }] });
    await act(async () => {
      await current.actualQuery().fetch();
    });
    await current.user.click(within(opened.dialog).getByRole("button", { name: "기록할 상태 다시 검토" }));
    await current.user.click(opened.confirm);
    expect(current.writes()).toHaveLength(0);
    expect(opened.dialog).toHaveTextContent("삭제되었다는 뜻은 아닙니다");
    expect(within(opened.dialog).getByRole("region", { name: "원래 검토 내용" })).not.toHaveTextContent(
      "CHANGED-METADATA",
    );
  });

  it("유효한 ACK 뒤 목록 실패는 기록을 반복하지 않고 GET만 복구한다", async () => {
    const current = await setupDomainReview(),
      opened = await current.open();
    current.response.review = () => {
      throw new Error("synthetic GET failed");
    };
    await current.user.click(opened.confirm);
    await within(opened.dialog).findByText("기록 응답은 확인했지만 목록을 다시 조회하지 못했습니다.");
    expect(current.writes()).toHaveLength(1);
    expect(domainToasts().success).toHaveBeenCalledTimes(1);
    current.response.review = undefined;
    await current.user.click(within(opened.dialog).getByRole("button", { name: "검토 목록 다시 조회" }));
    await within(opened.dialog).findByText(/검토 목록 조회를 완료했습니다/u);
    expect(current.writes()).toHaveLength(1);
    expect(within(opened.dialog).queryByRole("button", { name: "승인 상태 기록" })).not.toBeInTheDocument();
  });

  it("중복 클릭과 보관 콜백은 진행 중인 POST를 중복 전송하지 않는다", async () => {
    const current = await setupDomainReview(),
      opened = await current.open();
    const save = current.capture(opened.label),
      held = deferred<unknown>();
    current.response.action = () => held.promise;
    await invoke(save);
    await invoke(save);
    await current.user.click(opened.confirm);
    await current.user.keyboard("{Escape}");
    expect(current.writes()).toHaveLength(1);
    expect(opened.dialog).toBeInTheDocument();
    await act(async () => {
      held.resolve({ id: reviewRow.id, status: "approved" });
    });
    await waitFor(() => expect(domainToasts().success).toHaveBeenCalledTimes(1));
    await invoke(save);
    expect(current.writes()).toHaveLength(1);
  });
});
