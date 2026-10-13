import { useState } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";

import { ApiKeysTab } from "./ApiKeysTab";
import { accessKeys } from "./use-access-admin";
import { AppError } from "@/shared/api/error";
import { apiKeyPublicSchema } from "@/shared/api/domains/access.schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { testAuth } from "@/test/auth";
import { renderScreen } from "@/test/render";

const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const secret = "synthetic-owner-test-secret";
const row = apiKeyPublicSchema.parse({ id: "key_owned", name: "이전 계정의 키", status: "active" });

beforeEach(() => {
  tokenStore.clearAll();
  state.auth = testAuth();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

function mountKeys() {
  let refresh: () => void = () => undefined;
  function Harness() {
    const [, render] = useState(0);
    refresh = () => render((value) => value + 1);
    return (
      <FeatureAccessContext.Provider value={{ featureId: "access.users", permitted: true, readOnly: false }}>
        <ApiKeysTab canWrite isSuperAdmin writeDeniedReason="관리 변경 권한 필요" />
      </FeatureAccessContext.Provider>
    );
  }
  return { ...renderScreen(<Harness />), refresh: () => act(refresh) };
}

async function submitCreate() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "키 발급" }));
  const dialog = await screen.findByRole("dialog", { name: "API 키 발급" });
  await user.type(within(dialog).getByLabelText("이름", { exact: false }), "검증용 키");
  await user.click(within(dialog).getByRole("button", { name: "발급" }));
}

it.each(["id", "role", "roles", "team_id", "scopes"] as const)(
  "토큰 세대가 같아도 %s 변경 후 이전 발급 비밀값을 숨기고 목록을 새로 조회한다",
  async (dimension) => {
    const api = mockApi({
      "GET /admin/api-keys": () => ({ api_keys: [row] }),
      "POST /admin/api-keys": () => ({ api_key: row, secret }),
    });
    const view = mountKeys();
    await submitCreate();
    await screen.findByRole("dialog", { name: "발급된 비밀값" });
    const previousReads = api.calls.filter((call) => call.key === "GET /admin/api-keys").length;
    const epoch = tokenStore.getSessionEpoch();
    const user = state.auth.user;
    if (!user) throw new Error("authenticated fixture requires a user");
    state.auth = {
      ...state.auth,
      user: {
        ...user,
        [dimension]: dimension === "roles" || dimension === "scopes" ? ["admin:read"] : "changed",
      },
    };
    view.refresh();
    expect(tokenStore.getSessionEpoch()).toBe(epoch);
    expect(screen.queryByRole("dialog", { name: "발급된 비밀값" })).not.toBeInTheDocument();
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(api.calls.filter((call) => call.key === "GET /admin/api-keys").length).toBeGreaterThan(
        previousReads,
      ),
    );
  },
);

it.each([401, 403])(
  "목록 재조회가 %s이면 이전 데이터와 비밀값을 잠그고 성공 재조회로 풀지 않는다",
  async (status) => {
    let denied = false;
    mockApi({
      "GET /admin/api-keys": () => {
        if (denied) throw new AppError("조회 거부", { kind: "permission", status });
        return { api_keys: [row] };
      },
      "POST /admin/api-keys": () => ({ api_key: row, secret }),
    });
    const view = mountKeys();
    await submitCreate();
    await screen.findByRole("dialog", { name: "발급된 비밀값" });
    denied = true;
    await act(() => view.client.invalidateQueries({ queryKey: accessKeys.apiKeys }));
    await waitFor(() => expect(screen.queryByText(secret)).not.toBeInTheDocument());
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "키 발급" })).not.toBeInTheDocument();
    denied = false;
    await act(() => view.client.invalidateQueries({ queryKey: accessKeys.apiKeys }));
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  },
);

it.each(["unmount", "principal"] as const)(
  "%s 이후 늦은 발급 응답은 비밀값·알림·캐시 갱신을 만들지 않는다",
  async (change) => {
    let resolve!: (value: { api_key: typeof row; secret: string }) => void;
    const pending = new Promise<{ api_key: typeof row; secret: string }>((done) => {
      resolve = done;
    });
    const api = mockApi({
      "GET /admin/api-keys": () => ({ api_keys: [row] }),
      "POST /admin/api-keys": () => pending,
    });
    const view = mountKeys();
    await submitCreate();
    await waitFor(() => expect(api.bodies("POST /admin/api-keys")).toHaveLength(1));
    if (change === "unmount") view.unmount();
    else {
      state.auth = testAuth({ user: { id: "usr_next" } });
      view.refresh();
      await screen.findByRole("button", { name: "키 발급" });
    }
    const invalidates = vi.spyOn(view.client, "invalidateQueries");
    await act(async () => {
      resolve({ api_key: row, secret });
      await pending;
    });
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(invalidates).not.toHaveBeenCalled();
  },
);
