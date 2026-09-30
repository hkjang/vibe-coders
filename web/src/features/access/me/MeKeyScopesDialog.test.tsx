import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MeKeysTab } from "@/features/access/me/MeKeysTab";
import { confirmedMeScopeCatalog, meKeyScopeChoices } from "@/features/access/me/me-key-scopes";
import { useMeKeyScopeDraft } from "@/features/access/me/use-me-key-scope-draft";
import { meKeys } from "@/features/access/me/use-me-queries";
import { apiKeyPublicSchema, meKeysSchema } from "@/shared/api/domains/access.schemas";
import { publishLogout, tokenStore } from "@/shared/auth/token-store";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ role: "developer", scopes: ["chat:completion"] }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const row = apiKeyPublicSchema.parse({
  id: "key_personal",
  name: "개인 검토용 키",
  role: "developer",
  status: "active",
  scopes: ["models:read", "future:scope", "chat:completion"],
});
const endpoint = "PATCH /me/keys/key_personal";
const catalog = { api_keys: [row], role: "developer", grantable_scopes: [...row.scopes] };

function setup(update: ApiHandler = () => ({}), load: ApiHandler = () => catalog) {
  const api = mockApi({
    "GET /me/keys": load,
    "GET /me/sessions": () => ({ current_session_id: "", sessions: [] }),
    [endpoint]: update,
  });
  return {
    api,
    ...renderScreen(
      <main id="main-content" tabIndex={-1}>
        <MeKeysTab />
      </main>,
    ),
  };
}

async function openEditor(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "권한 수정" }));
  return await screen.findByRole("dialog", { name: "내 API 키 권한 수정" });
}

function scope(dialog: HTMLElement, value: string) {
  return within(dialog).getByRole("checkbox", { name: new RegExp(value) });
}

function scopeForm(dialog: HTMLElement) {
  const form = dialog.querySelector("form");
  if (!form) throw new Error("missing personal scope form");
  return form;
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

describe("개인 키 권한 계약", () => {
  it("정상 빈 부여 목록과 미확인 응답을 구분하며 잘못된 타입은 거부한다", () => {
    const empty = meKeysSchema.parse({ ...catalog, grantable_scopes: [] });
    const missing = meKeysSchema.parse({ api_keys: [row], role: "developer" });
    const unknown = meKeysSchema.parse({ ...catalog, grantable_scopes: null });
    const state = { status: "success", fetchStatus: "idle" } as const;
    expect(confirmedMeScopeCatalog({ ...state, data: empty })).toEqual([]);
    expect(missing.grantable_scopes).toBeUndefined();
    expect(unknown.grantable_scopes).toBeNull();
    expect(confirmedMeScopeCatalog({ ...state, data: missing })).toBeUndefined();
    expect(confirmedMeScopeCatalog({ ...state, data: unknown })).toBeUndefined();
    expect(meKeysSchema.safeParse({ ...catalog, grantable_scopes: "chat:completion" }).success).toBe(false);
    expect(confirmedMeScopeCatalog({ ...state, data: catalog, isInvalidated: true })).toBeUndefined();
    expect(confirmedMeScopeCatalog({ ...state, data: catalog, fetchStatus: "paused" })).toBeUndefined();
    expect(
      confirmedMeScopeCatalog({ ...state, data: { ...catalog, grantable_scopes: [""] } }),
    ).toBeUndefined();
  });

  it("개인 옵션은 전달한 값만 표시하며 미설명·빈 식별자를 임의로 삭제하지 않는다", () => {
    expect(meKeyScopeChoices(["future:scope", "", "future:scope"]).map(({ value }) => value)).toEqual([
      "future:scope",
      "",
    ]);
    expect(meKeyScopeChoices(["chat:completion"])).toMatchObject([
      { value: "chat:completion", label: "대화 생성" },
    ]);
    expect(meKeyScopeChoices(["future:scope"])[0]).toMatchObject({ label: "기타 권한" });
  });

  it("같은 세션의 이전 편집 인스턴스는 새 편집을 닫을 수 없다", () => {
    const { result } = renderHook(() => useMeKeyScopeDraft());
    const trigger = document.createElement("button");
    act(() => result.current.open(row, trigger));
    const first = result.current.target;
    if (!first) throw new Error("missing first editor instance");
    expect(first.row.scopes).not.toBe(row.scopes);
    act(() => result.current.close(first.instance));
    act(() => result.current.open({ ...row, id: "other_key" }, trigger));
    act(() => result.current.close(first.instance));
    expect(result.current.target?.row.id).toBe("other_key");
  });
});

describe("개인 API 키 권한 초안", () => {
  it("관리자 조회 없이 한글 권한과 현재 부여 가능한 값만 표시한다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const dialog = await openEditor(user);
    expect(scope(dialog, "chat:completion")).toHaveAccessibleName(/대화 생성/u);
    expect(scope(dialog, "future:scope")).toHaveAccessibleName(/기타 권한/u);
    expect(within(dialog).queryByRole("checkbox", { name: /admin:write/u })).not.toBeInTheDocument();
    expect(api.calls.some(({ key }) => key.includes("/admin/"))).toBe(false);
    expect(dialog).toHaveTextContent("다른 곳에서의 동시 변경을 막지는 않습니다");
  });

  it("dirty Escape/취소에 계속 편집과 버리기를 제공하고 정확한 버튼으로 돌아간다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const dialog = await openEditor(user);
    await user.click(scope(dialog, "models:read"));
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await user.keyboard("{Escape}");
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "계속 편집" }),
    );
    expect(scope(dialog, "models:read")).not.toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "권한 수정" })).toHaveFocus();
    expect(api.bodies(endpoint)).toEqual([]);
    const cleanUnload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);
  });

  it("정렬이 다른 기존 선택을 원복하면 dirty가 해제된다", async () => {
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

  it.each(["missing", "null"])("%s 부여 목록은 미확인으로 저장 및 직접 제출을 막는다", async (shape) => {
    const user = userEvent.setup();
    const { api } = setup(undefined, () => ({
      api_keys: [row],
      role: "developer",
      ...(shape === "null" ? { grantable_scopes: null } : {}),
    }));
    const dialog = await openEditor(user);
    expect(dialog).toHaveTextContent("부여 가능한 권한을 확인하기 전에는 저장할 수 없습니다");
    expect(within(dialog).getByRole("button", { name: "권한 저장" })).toBeDisabled();
    fireEvent.submit(scopeForm(dialog));
    expect(api.bodies(endpoint)).toEqual([]);
    expect(scope(dialog, "future:scope")).toBeChecked();
  });

  it("정상 빈 부여 목록은 기존 선택을 직접 해제한 뒤 명시적 [] 저장을 허용한다", async () => {
    const user = userEvent.setup();
    const { api } = setup(undefined, () => ({ ...catalog, grantable_scopes: [] }));
    const dialog = await openEditor(user);
    expect(dialog).toHaveTextContent("현재 부여할 수 있는 권한이 없습니다");
    expect(within(dialog).getByRole("button", { name: "권한 저장" })).toBeDisabled();
    for (const value of row.scopes) await user.click(scope(dialog, value));
    expect(dialog).toHaveTextContent("현재 선택: 선택된 권한 없음");
    expect(dialog).toHaveTextContent("역할 권한을 자동 상속하지 않습니다");
    expect(dialog).toHaveTextContent("필요한 권한이 없는 호출이 거부됩니다");
    expect(dialog).toHaveTextContent("별도의 ‘폐기’ 작업");
    await user.click(within(dialog).getByRole("button", { name: "권한 저장" }));
    await waitFor(() => expect(api.bodies(endpoint)).toEqual([{ scopes: [] }]));
  });

  it("목록의 빈 권한도 상속으로 표시하지 않고 폐기된 키는 편집하지 못한다", async () => {
    setup(undefined, () => ({ ...catalog, api_keys: [{ ...row, scopes: [], status: "revoked" }] }));
    expect(await screen.findByText("선택된 권한 없음")).toBeVisible();
    expect(screen.queryByText("역할 스코프를 상속합니다.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "권한 수정" })).toBeDisabled();
  });

  it("목록 재조회 중 저장을 막되 편집과 닫기는 허용하며 결과가 초안을 덮지 않는다", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    let reads = 0;
    const { api } = setup(undefined, () => (++reads === 1 ? catalog : pending.promise));
    const dialog = await openEditor(user);
    await user.click(within(dialog).getByRole("button", { name: "허용 권한 새로고침" }));
    expect(within(dialog).getByRole("button", { name: "권한 저장" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeEnabled();
    await user.click(scope(dialog, "models:read"));
    fireEvent.submit(scopeForm(dialog));
    expect(api.bodies(endpoint)).toEqual([]);
    await act(async () =>
      pending.resolve({ ...catalog, api_keys: [{ ...row, name: "새 이름", scopes: [] }] }),
    );
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "권한 저장" })).toBeEnabled());
    expect(dialog).toHaveTextContent(row.name);
    expect(scope(dialog, "models:read")).not.toBeChecked();
    expect(scope(dialog, "future:scope")).toBeChecked();
  });

  it("오래된 목록이 있어도 조회 실패는 Request ID와 재시도를 보이고 저장을 막는다", async () => {
    const user = userEvent.setup();
    let reads = 0;
    const { api } = setup(undefined, () => {
      if (++reads === 2) throw apiFailure("private read failure", 503, "req-me-catalog");
      return catalog;
    });
    const dialog = await openEditor(user);
    await user.click(scope(dialog, "models:read"));
    await user.click(within(dialog).getByRole("button", { name: "허용 권한 새로고침" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("req-me-catalog");
    expect(dialog).not.toHaveTextContent("private read failure");
    expect(within(dialog).getByRole("button", { name: "권한 저장" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "권한 저장" })).toBeEnabled());
    expect(scope(dialog, "models:read")).not.toBeChecked();
    expect(api.bodies(endpoint)).toEqual([]);
  });

  it("부여 목록 밖 기존 선택은 보존하며 직접 해제한 뒤에만 저장한다", async () => {
    const user = userEvent.setup();
    const { api } = setup(undefined, () => ({
      ...catalog,
      grantable_scopes: ["chat:completion", "models:read"],
    }));
    const dialog = await openEditor(user);
    expect(dialog).toHaveTextContent("현재 내가 부여할 수 없는 권한이 선택되어 있습니다");
    expect(scope(dialog, "future:scope")).toBeChecked();
    expect(within(dialog).getByRole("button", { name: "권한 저장" })).toBeDisabled();
    await user.click(scope(dialog, "future:scope"));
    await user.click(within(dialog).getByRole("button", { name: "권한 저장" }));
    await waitFor(() =>
      expect(api.bodies(endpoint)).toEqual([{ scopes: ["chat:completion", "models:read"] }]),
    );
  });

  it("선택한 새 값이 catalog에서 사라져도 해제할 체크박스를 유지한다", async () => {
    const user = userEvent.setup();
    const { client } = setup(undefined, () => ({
      ...catalog,
      grantable_scopes: [...row.scopes, "future:new"],
    }));
    const dialog = await openEditor(user);
    await user.click(scope(dialog, "future:new"));
    act(() => client.setQueryData(meKeys.keys, catalog));
    expect(scope(dialog, "future:new")).toBeChecked();
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "권한 저장" })).toBeDisabled());
    await user.click(scope(dialog, "future:new"));
    expect(within(dialog).getByRole("button", { name: "권한 저장" })).toBeEnabled();
  });

  it.each(["changed", "fetching", "error", "invalidated"])(
    "같은 작업의 검증 중 catalog %s 전환은 PATCH 직전에도 검증한다",
    async (state) => {
      const user = userEvent.setup();
      const pending = deferred();
      let reads = 0;
      const { api, client } = setup(undefined, () => (++reads === 1 ? catalog : pending.promise));
      const dialog = await openEditor(user);
      await act(async () => {
        fireEvent.submit(scopeForm(dialog));
        if (state === "changed") client.setQueryData(meKeys.keys, { ...catalog, grantable_scopes: [] });
        else if (state === "invalidated")
          await client.invalidateQueries({ queryKey: meKeys.keys, refetchType: "none" });
        else {
          const request = client.refetchQueries({ queryKey: meKeys.keys });
          if (state === "error") {
            pending.reject(apiFailure("private error", 500, "req-me-same-tick"));
            await request;
          }
        }
        await Promise.resolve();
      });
      expect(api.bodies(endpoint)).toEqual([]);
      expect(scope(dialog, "future:scope")).toBeChecked();
      expect(within(dialog).getByRole("button", { name: "권한 저장" })).toBeDisabled();
      if (state === "fetching") await act(async () => pending.resolve(catalog));
    },
  );

  it("refetch는 대상 이름·ID·baseline을 바꾸지 않으며 같은 키 버튼에 focus를 돌린다", async () => {
    const user = userEvent.setup();
    const { client, api } = setup();
    const dialog = await openEditor(user);
    await user.click(scope(dialog, "models:read"));
    act(() =>
      client.setQueryData(meKeys.keys, {
        ...catalog,
        api_keys: [
          { ...row, id: "other_key", name: "다른 키" },
          { ...row, name: "갱신된 키", scopes: [] },
        ],
      }),
    );
    expect(dialog).toHaveTextContent(row.name);
    expect(scope(dialog, "future:scope")).toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", { name: "변경 버리기" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    const refreshed = screen.getByText("갱신된 키").closest("li");
    if (!refreshed) throw new Error("missing refreshed key row");
    expect(within(refreshed).getByRole("button", { name: "권한 수정" })).toHaveFocus();
    await user.click(within(refreshed).getByRole("button", { name: "권한 수정" }));
    const reopened = await screen.findByRole("dialog", { name: "내 API 키 권한 수정" });
    expect(scope(reopened, "chat:completion")).not.toBeChecked();
    await user.click(scope(reopened, "chat:completion"));
    await user.click(within(reopened).getByRole("button", { name: "권한 저장" }));
    await waitFor(() => expect(api.bodies(endpoint)).toEqual([{ scopes: ["chat:completion"] }]));
  });

  it("대상이 사라지면 다른 키 대신 본문으로 focus를 돌린다", async () => {
    const user = userEvent.setup();
    const { client } = setup();
    const dialog = await openEditor(user);
    act(() => client.setQueryData(meKeys.keys, { ...catalog, api_keys: [{ ...row, id: "other_key" }] }));
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.getByRole("main")).toHaveFocus());
    expect(screen.getByRole("button", { name: "권한 수정" })).not.toHaveFocus();
  });

  it("단일 immutable PATCH와 pending 잠금, 실패 후 초안 및 Request ID 재시도를 보장한다", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    let writes = 0;
    const { api } = setup(() => (++writes === 1 ? pending.promise : {}));
    const dialog = await openEditor(user);
    await user.click(scope(dialog, "models:read"));
    act(() => {
      fireEvent.submit(scopeForm(dialog));
      fireEvent.submit(scopeForm(dialog));
    });
    const first = { scopes: ["chat:completion", "future:scope"] };
    await waitFor(() => expect(api.bodies(endpoint)).toEqual([first]));
    expect(scope(dialog, "chat:completion")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "대화상자 닫기" }));
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    await act(async () => pending.reject(apiFailure("private PATCH error", 500, "req-me-scope")));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("req-me-scope");
    expect(dialog).not.toHaveTextContent("private PATCH error");
    expect(scope(dialog, "future:scope")).toBeChecked();
    await user.click(scope(dialog, "chat:completion"));
    expect(api.bodies(endpoint)).toEqual([first]);
    await user.click(within(dialog).getByRole("button", { name: "권한 저장" }));
    await waitFor(() => expect(api.bodies(endpoint)).toEqual([first, { scopes: ["future:scope"] }]));
  });

  it.each([
    { transition: "logout", result: "success" },
    { transition: "logout", result: "failure" },
    { transition: "session", result: "success" },
    { transition: "session", result: "failure" },
  ])(
    "$transition 후 늦은 $result 응답은 새 writable 초안·토스트·캐시에 영향을 주지 않는다",
    async ({ transition, result }) => {
      const user = userEvent.setup();
      const pending = deferred();
      let writes = 0;
      const { api, client } = setup(() => (++writes === 1 ? pending.promise : {}));
      const dialog = await openEditor(user);
      await user.click(scope(dialog, "models:read"));
      await user.click(within(dialog).getByRole("button", { name: "권한 저장" }));
      await waitFor(() => expect(api.bodies(endpoint)).toHaveLength(1));
      act(() => {
        if (transition === "logout") publishLogout();
        else tokenStore.setLegacyToken("synthetic-personal-session");
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "권한 수정" }));
      const reopened = await screen.findByRole("dialog", { name: "내 API 키 권한 수정" });
      await user.click(scope(reopened, "chat:completion"));
      expect(within(reopened).getByRole("button", { name: "권한 저장" })).toBeEnabled();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      vi.mocked(toast.success).mockClear();
      vi.mocked(toast.error).mockClear();
      await act(async () => {
        if (result === "success") pending.resolve({});
        else pending.reject(apiFailure("old private error", 500, "req-old-personal"));
      });
      expect(reopened).toBeVisible();
      expect(scope(reopened, "chat:completion")).not.toBeChecked();
      expect(scope(reopened, "models:read")).toBeChecked();
      expect(within(reopened).queryByRole("alert")).not.toBeInTheDocument();
      expect(invalidate).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      await user.click(within(reopened).getByRole("button", { name: "권한 저장" }));
      await waitFor(() =>
        expect(api.bodies(endpoint)).toEqual([
          { scopes: ["chat:completion", "future:scope"] },
          { scopes: ["future:scope", "models:read"] },
        ]),
      );
    },
  );

  it("같은 작업의 validation 중 세션 변경은 PATCH 이전에 이전 초안을 폐기한다", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    const dialog = await openEditor(user);
    await user.click(scope(dialog, "models:read"));
    await act(async () => {
      fireEvent.submit(scopeForm(dialog));
      tokenStore.setLegacyToken("synthetic-personal-session");
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.bodies(endpoint)).toEqual([]);
  });
});
