import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { deferred, policy, savePath, setupEditor } from "./policy-editor-test-harness";

describe("정책 목록의 현재 조회 소유자와 변경 근거", () => {
  it.each(["changed", "denied"])("열린 사용 확인은 %s 목록을 근거로 전송하지 않는다", async (change) => {
    const c = await setupEditor();
    await c.user.click(screen.getByRole("button", { name: `${policy.name} 사용` }));
    const dialog = screen.getByRole("dialog", { name: "정책을 사용할까요?" });
    if (change === "changed") c.response.rows = [{ ...policy, description: "다른 운영자가 변경한 원본" }];
    else
      c.response.list = () => {
        throw new AppError("private failure", { kind: "http", status: 403 });
      };
    await act(async () => {
      await c.view.client.refetchQueries({ queryKey: ["governance", "policies"] });
    });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "사용" })).toBeDisabled());
    await c.user.click(within(dialog).getByRole("button", { name: "사용" }));
    expect(c.api.bodies(savePath)).toEqual([]);
  });
  it.each([401, 403, 503])("재조회 %s 뒤 기존 정책과 상태 변경을 노출하지 않는다", async (status) => {
    const c = await setupEditor();
    c.response.list = () => {
      throw new AppError("private failure", { kind: "http", status });
    };
    await act(async () => {
      await c.view.client.refetchQueries({ queryKey: ["governance", "policies"] });
    });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: `${policy.name} 사용` })).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(policy.name ?? "")).not.toBeInTheDocument();
  });

  it.each(["principal", "session"])("%s 변경 중 이전 목록을 표시하거나 변경하지 않는다", async (boundary) => {
    const c = await setupEditor();
    const held = deferred<unknown>();
    c.response.list = () => held.promise;
    if (boundary === "principal") c.update({ principal: "reader-b" });
    else act(() => tokenStore.clearAll());
    expect(screen.queryByRole("button", { name: `${policy.name} 사용` })).not.toBeInTheDocument();
    await act(async () => held.resolve({ policies: [] }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: `${policy.name} 사용` })).not.toBeInTheDocument(),
    );
  });
});
