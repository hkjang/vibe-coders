import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { acknowledgement, advice, applyPath, deferred, setupDraft } from "./policy-draft-test-harness";

describe("검토의 이름·조회 수명 정밀 경계", () => {
  for (const title of ["", "\u0085", "\ufeff"]) {
    it(`${JSON.stringify(title)}의 저장명 안내와 원래 payload를 분리한다`, async () => {
      const c = await setupDraft();
      c.response.rows = [{ ...advice, id: "review-name", title }];
      await act(async () => {
        await c.view.client.refetchQueries({ queryKey: ["governance", "advisor"] });
      });
      await waitFor(() => expect(screen.queryByText(advice.title ?? "")).not.toBeInTheDocument());
      await c.user.click(c.button());
      const label = within(c.dialog()).getByText("저장될 정책 이름");
      expect(label.nextElementSibling?.textContent).toBe(
        title === "\ufeff" ? "[draft] \ufeff" : "[draft] advisor 추천 정책",
      );
      await c.user.click(c.confirm());
      expect(c.api.bodies(applyPath)).toEqual([
        { title, conditions: advice.conditions, actions: advice.actions },
      ]);
    });
  }
  it("A기간의 늦은 추천 조회 실패를 B기간의 오류나 pending으로 남기지 않는다", async () => {
    const c = await setupDraft();
    await c.user.click(c.button());
    c.update({ mode: "read_only" });
    const held = deferred<unknown>();
    let calls = 0;
    c.response.suggestions = () =>
      ++calls === 1 ? held.promise : { suggestions: [{ ...advice, id: "period-b" }] };
    await c.user.click(within(c.dialog()).getByRole("button", { name: "목록 다시 조회" }));
    c.changeWindow("30d");
    await waitFor(() => expect(calls).toBe(2));
    await act(async () => held.reject(new Error("public A lookup failed")));
    c.update({ mode: "writable" });
    expect(c.dialog()).not.toHaveTextContent("추천 목록을 갱신하지 못했습니다.");
    await waitFor(() =>
      expect(within(c.dialog()).getByRole("button", { name: "원래 규칙 다시 확인" })).toBeEnabled(),
    );
    await c.user.click(within(c.dialog()).getByRole("button", { name: "원래 규칙 다시 확인" }));
    await c.user.click(c.confirm());
    expect(await screen.findByText("비활성 정책 초안을 생성했습니다.")).toBeVisible();
    expect(c.api.bodies(applyPath)).toHaveLength(1);
    expect(acknowledgement.enabled).toBe(false);
  });
});
