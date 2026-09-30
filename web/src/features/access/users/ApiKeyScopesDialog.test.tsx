import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiKeysTab } from "@/features/access/users/ApiKeysTab";
import { apiKeyScopeChoices } from "@/features/access/users/api-key-scopes";
import { accessKeys } from "@/features/access/users/use-access-admin";
import { apiKeyPublicSchema } from "@/shared/api/domains/access.schemas";
import { publishLogout, tokenStore } from "@/shared/auth/token-store";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ role: "admin", scopes: ["admin:read", "admin:write"] }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const row = apiKeyPublicSchema.parse({
  id: "key_scope",
  name: "검토용 키",
  role: "developer",
  status: "active",
  scopes: ["models:read", "future:scope", "chat:completion"],
});
const endpoint = "PATCH /admin/api-keys/key_scope";

function setup(update: ApiHandler = () => ({}), canWrite = true) {
  const api = mockApi({ "GET /admin/api-keys": () => ({ api_keys: [row] }), [endpoint]: update });
  return {
    api,
    ...renderScreen(
      <main id="main-content" tabIndex={-1}>
        <ApiKeysTab canWrite={canWrite} isSuperAdmin writeDeniedReason="관리 변경 권한 필요" />
      </main>,
    ),
  };
}

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "권한 수정" }));
  return await screen.findByRole("dialog", { name: "API 키 권한 수정" });
}

function scope(dialog: HTMLElement, value: string) {
  return within(dialog).getByRole("checkbox", { name: new RegExp(value) });
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => tokenStore.clearAll());

describe("API 키 권한 초안", () => {
  it("한국어 설명과 기존 미등록 권한을 표시하고 값만 바꿔도 닫기를 보호한다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const dialog = await openEditor(user);
    expect(scope(dialog, "chat:completion")).toHaveAccessibleName(/대화 생성/);
    expect(scope(dialog, "future:scope")).toBeChecked();
    expect(dialog).toHaveTextContent("다른 관리자의 동시 변경을 막지는 않습니다");
    await user.click(scope(dialog, "chat:completion"));
    await user.keyboard("{Escape}");
    const guard = await screen.findByRole("alertdialog");
    await user.click(within(guard).getByRole("button", { name: "계속 편집" }));
    expect(scope(dialog, "chat:completion")).not.toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "권한 수정" })).toHaveFocus();
    expect(api.bodies(endpoint)).toEqual([]);
  });

  it("순서가 다른 기존 권한도 해제 후 원복하면 변경 없음으로 닫는다", async () => {
    const user = userEvent.setup();
    setup();
    const dialog = await openEditor(user);
    await user.click(scope(dialog, "models:read"));
    await user.click(scope(dialog, "models:read"));
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(row.scopes).toEqual(["models:read", "future:scope", "chat:completion"]);
  });

  it("미등록 권한을 보존하며 다른 필드 없이 선택한 권한만 저장한다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const dialog = await openEditor(user);
    await user.click(scope(dialog, "models:read"));
    await user.click(within(dialog).getByRole("button", { name: "권한 저장" }));
    await waitFor(() =>
      expect(api.bodies(endpoint)).toEqual([{ scopes: ["chat:completion", "future:scope"] }]),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("모두 해제하면 기존 역할 상속 계약대로 명시적 빈 배열을 보낸다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const dialog = await openEditor(user);
    for (const value of row.scopes) await user.click(scope(dialog, value));
    expect(dialog).toHaveTextContent("현재 선택: 역할 권한 상속");
    await user.click(within(dialog).getByRole("button", { name: "권한 저장" }));
    await waitFor(() => expect(api.bodies(endpoint)).toEqual([{ scopes: [] }]));
  });

  it("목록 갱신은 열린 초안과 기준을 바꾸지 않고 동일 키의 새 버튼으로 포커스를 돌린다", async () => {
    const user = userEvent.setup();
    const { client, api } = setup();
    const dialog = await openEditor(user);
    await user.click(scope(dialog, "models:read"));
    act(() =>
      client.setQueryData(accessKeys.apiKeys, {
        api_keys: [
          { ...row, id: "other_key", name: "다른 키" },
          { ...row, name: "갱신된 키", scopes: ["admin:read"] },
        ],
      }),
    );
    expect(dialog).toHaveTextContent("검토용 키");
    expect(scope(dialog, "future:scope")).toBeChecked();
    expect(scope(dialog, "admin:read")).not.toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const refreshed = screen.getByRole("row", { name: /갱신된 키/ });
    expect(within(refreshed).getByRole("button", { name: "권한 수정" })).toHaveFocus();
    expect(api.bodies(endpoint)).toEqual([]);
    await user.click(within(refreshed).getByRole("button", { name: "권한 수정" }));
    const reopened = await screen.findByRole("dialog", { name: "API 키 권한 수정" });
    expect(scope(reopened, "admin:read")).toBeChecked();
    expect(scope(reopened, "models:read")).not.toBeChecked();
  });

  it("대기 중 입력과 중복 제출을 잠그고 실패 뒤 입력과 요청 ID를 유지한다", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    let calls = 0;
    const { api } = setup(() => (++calls === 1 ? pending.promise : {}));
    const dialog = await openEditor(user);
    await user.click(scope(dialog, "models:read"));
    const form = dialog.querySelector("form");
    if (!form) throw new Error("missing scope form");
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    const first = { scopes: ["chat:completion", "future:scope"] };
    await waitFor(() => expect(api.bodies(endpoint)).toEqual([first]));
    expect(scope(dialog, "chat:completion")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled();
    await user.click(scope(dialog, "chat:completion"));
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    expect(api.bodies(endpoint)).toEqual([first]);
    await act(async () => pending.reject(apiFailure("private server detail", 500, "req-key-scope")));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("req-key-scope");
    expect(dialog).not.toHaveTextContent("private server detail");
    expect(scope(dialog, "chat:completion")).toBeEnabled();
    expect(scope(dialog, "future:scope")).toBeChecked();
    await user.click(scope(dialog, "chat:completion"));
    expect(api.bodies(endpoint)).toEqual([first]);
    await user.click(within(dialog).getByRole("button", { name: "권한 저장" }));
    await waitFor(() => expect(api.bodies(endpoint)).toEqual([first, { scopes: ["future:scope"] }]));
  });

  it.each([
    { transition: "logout", result: "success" },
    { transition: "logout", result: "failure" },
    { transition: "new-session", result: "success" },
    { transition: "new-session", result: "failure" },
  ])(
    "$transition 이후 늦은 $result 결과는 새 초안을 닫거나 덮어쓰지 않는다",
    async ({ transition, result }) => {
      const user = userEvent.setup();
      const pending = deferred();
      const { api, client } = setup(() => pending.promise);
      const dialog = await openEditor(user);
      await user.click(scope(dialog, "models:read"));
      await user.click(within(dialog).getByRole("button", { name: "권한 저장" }));
      await waitFor(() => expect(api.bodies(endpoint)).toHaveLength(1));
      act(() => {
        if (transition === "logout") publishLogout();
        else tokenStore.setLegacyToken("synthetic-new-session");
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      // Auth is mocked in this unit: the real router remounts this screen after
      // login. Open directly to isolate old/new draft ownership from Radix's
      // asynchronous focus restoration during that security-only unmount.
      fireEvent.click(screen.getByRole("button", { name: "권한 수정" }));
      const reopened = await screen.findByRole("dialog", { name: "API 키 권한 수정" });
      expect(scope(reopened, "models:read")).toBeChecked();
      await user.click(scope(reopened, "chat:completion"));
      const invalidate = vi.spyOn(client, "invalidateQueries");
      await act(async () => {
        if (result === "success") pending.resolve({});
        else pending.reject(apiFailure("old session private error", 500, "old-request"));
      });
      expect(reopened).toBeVisible();
      expect(scope(reopened, "chat:completion")).not.toBeChecked();
      expect(scope(reopened, "models:read")).toBeChecked();
      expect(within(reopened).queryByRole("alert")).not.toBeInTheDocument();
      expect(invalidate).not.toHaveBeenCalled();
      expect(api.bodies(endpoint)).toHaveLength(1);
    },
  );

  it("검증이 끝나기 전 같은 작업에서 세션이 바뀌면 이전 초안을 전송하지 않는다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const dialog = await openEditor(user);
    await user.click(scope(dialog, "models:read"));
    const form = dialog.querySelector("form");
    if (!form) throw new Error("missing scope form");
    await act(async () => {
      fireEvent.submit(form);
      tokenStore.setLegacyToken("synthetic-new-session");
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.bodies(endpoint)).toEqual([]);
  });

  it("원래 키가 목록에서 사라지면 다른 키가 아니라 본문으로 포커스를 돌린다", async () => {
    const user = userEvent.setup();
    const { client } = setup();
    const dialog = await openEditor(user);
    await user.click(scope(dialog, "models:read"));
    act(() =>
      client.setQueryData(accessKeys.apiKeys, { api_keys: [{ ...row, id: "other_key", name: "다른 키" }] }),
    );
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
    );
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
    expect(screen.getByRole("button", { name: "권한 수정" })).not.toHaveFocus();
  });

  it("읽기 전용 사용자는 권한 편집을 열 수 없다", async () => {
    setup(undefined, false);
    expect(await screen.findByRole("button", { name: "권한 수정" })).toBeDisabled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("미등록·빈 식별자·중복 선택값을 목록에서 임의로 제거하지 않는다", () => {
    const choices = apiKeyScopeChoices(["future:scope", "", "future:scope"]);
    expect(choices.filter((choice) => choice.value === "future:scope")).toHaveLength(1);
    expect(choices.find((choice) => choice.value === "")).toMatchObject({ label: "기타 권한" });
  });
});
