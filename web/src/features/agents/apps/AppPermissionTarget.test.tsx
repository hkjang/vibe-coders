import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { appPermissionSchema, appPermissionTarget } from "./app-permission-form";
import { app, openPanel, path, row, setup } from "./app-permission-test-support";
import { useAppPermissionDraft } from "./use-app-permission-draft";
import { tokenStore } from "@/shared/auth/token-store";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { mockApi } from "@/test/api";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
beforeEach(() => tokenStore.clearAll());

const changedIDs = ["\uFEFFalice", "alice\uFEFF", " alice "];
const exactIDs = ["alice", "팀 / 사용자+ID?&#", "al\uFEFFice", "\u200Balice"];

describe("기존 앱 권한의 정확한 회수 대상", () => {
  it("부여 입력의 trim과 달리 기존 ID를 정규화해 회수 대상으로 사용하지 않는다", () => {
    for (const subject_id of changedIDs) {
      expect(appPermissionSchema.parse({ subject_type: "user", subject_id }).subject_id).toBe("alice");
      expect(appPermissionTarget({ ...row, subject_id })).toBeUndefined();
    }
    for (const subject_id of exactIDs)
      expect(appPermissionTarget({ ...row, subject_id })).toEqual({ subject_type: "user", subject_id });
  });

  it("alice와 FEFFalice·공백 패딩 행이 함께 있어도 비정규 행의 회수를 차단한다", async () => {
    const user = userEvent.setup();
    const { api } = setup({
      load: () => ({
        permissions: ["alice", ...changedIDs].map((subject_id, index) => ({
          ...row,
          id: `exact-${index}`,
          subject_id,
        })),
      }),
    });
    await openPanel(user);
    const table = await screen.findByRole("table", { name: "앱 추가 접근 권한 목록" });
    for (const subject_id of ["alice", ...changedIDs]) {
      // Accessible-name matching trims invisible edges, so identify the stored
      // value by its exact textContent rather than conflating these distinct IDs.
      const targetRow = [...table.querySelectorAll("tbody tr")].find(
        (element) => element.querySelectorAll("td")[1]?.textContent === subject_id,
      );
      if (!targetRow) throw new Error("missing exact permission row");
      const button = within(targetRow as HTMLElement).getByRole("button");
      if (subject_id === "alice") expect(button).toBeEnabled();
      else {
        expect(button).toBeDisabled();
        fireEvent.click(button);
      }
    }
    expect(screen.queryByRole("dialog", { name: "앱 추가 접근 권한 회수" })).not.toBeInTheDocument();
    expect(api.calls.filter(({ key }) => key.startsWith("DELETE"))).toEqual([]);
  });

  it.each(exactIDs)("정확한 Unicode ID %j 는 같은 tuple로만 회수한다", async (subject_id) => {
    const user = userEvent.setup();
    const { api } = setup({ load: () => ({ permissions: [{ ...row, subject_id }] }) });
    await openPanel(user);
    const table = await screen.findByRole("table", { name: "앱 추가 접근 권한 목록" });
    await user.click(within(table).getByRole("button"));
    const dialog = await screen.findByRole("dialog", { name: "앱 추가 접근 권한 회수" });
    await user.click(within(dialog).getByRole("button", { name: "권한 회수" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(api.calls.filter(({ key }) => key.startsWith("DELETE"))).toEqual([
      { key: `DELETE ${path}`, options: { body: undefined, query: { subject_type: "user", subject_id } } },
    ]);
  });

  it.each(changedIDs)(
    "제출 경계에서도 비정규 snapshot %j 를 다른 대상의 DELETE로 바꾸지 않는다",
    async (subject_id) => {
      const api = mockApi({ [`DELETE ${path}`]: () => ({}) });
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      function Wrapper({ children }: PropsWithChildren) {
        return (
          <QueryClientProvider client={client}>
            <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
          </QueryClientProvider>
        );
      }
      const { result } = renderHook(() => useAppPermissionDraft(true), { wrapper: Wrapper });
      act(() =>
        result.current.open(app, document.createElement("button"), { subject_type: "user", subject_id }),
      );
      const target = result.current.target;
      if (!target) throw new Error("missing revoke snapshot");
      await act(async () => {
        await expect(
          result.current.submit(target, { subject_type: "user", subject_id: "alice" }),
        ).rejects.toThrow("대상 ID를 변경하지 않고 확인할 수 없어 회수할 수 없습니다.");
      });
      expect(api.calls).toEqual([]);
      expect(result.current.target?.subject?.subject_id).toBe(subject_id);
      expect(result.current.pending).toBe(false);
    },
  );
});
