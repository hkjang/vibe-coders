import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render as renderComponent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useRef, useState, type ReactNode } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderDeleteDialog } from "@/features/gateway/providers/ProviderDeleteDialog";
import { ProviderEditDialog } from "@/features/gateway/providers/ProviderEditDialog";
import { providerImpactAcknowledgement } from "@/features/gateway/providers/ProviderImpactPanel";
import { providerImpactFixture } from "@/features/gateway/providers/provider-impact-test-fixtures";
import { buildProviderRows, type ProviderCatalogRow } from "@/features/gateway/providers/provider-catalog";
import type { ProviderWriteBody } from "@/shared/api/domains/gateway";
import type { Provider } from "@/shared/api/schemas";
import { publishLogout, tokenStore } from "@/shared/auth/token-store";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { apiFailure, mockApi } from "@/test/api";
import { FeatureAccessHarness } from "@/test/feature-access";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});

function render(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return renderComponent(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <FeatureAccessHarness featureId="gateway.providers">{children}</FeatureAccessHarness>
      </QueryClientProvider>
    ),
  });
}

beforeEach(() => {
  mockApi({
    "GET /admin/provider-impact": ({ query }) =>
      providerImpactFixture((query as { provider_ref: string }).provider_ref),
  });
});

async function acknowledge(user: ReturnType<typeof userEvent.setup>) {
  const checkbox = await screen.findByRole("checkbox", { name: new RegExp(providerImpactAcknowledgement) });
  await waitFor(() => expect(checkbox).toBeEnabled());
  if (!(checkbox as HTMLInputElement).checked) await user.click(checkbox);
}

const provider: Provider = {
  name: "public-provider",
  provider_ref: `prv_${"a".repeat(43)}`,
  base_url: "https://public.example/v1",
  api_key_configured: true,
  timeout_ms: 30000,
  enabled: true,
  model_patterns: "public-*",
  failover_group: "public-group",
  priority: 10,
  created_at: "2026-09-01T00:00:00Z",
};
function catalogRow(value: Provider): ProviderCatalogRow {
  const result = buildProviderRows([value])[0];
  if (!result) throw new Error("missing synthetic provider row");
  return result;
}
const row = catalogRow(provider);

function formOf(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  if (!form) throw new Error("missing form");
  return form;
}

function Harness({
  credentialPrefixes,
  mode = "edit",
  snapshot = row,
  save = async () => undefined,
  remove = async () => undefined,
}: {
  credentialPrefixes?: readonly string[];
  mode?: "edit" | "delete";
  snapshot?: ProviderCatalogRow;
  save?: (body: ProviderWriteBody) => Promise<unknown>;
  remove?: (identifier: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} onClick={() => setOpen(true)}>
        열기
      </button>
      {open ? (
        mode === "edit" ? (
          <ProviderEditDialog
            credentialPrefixes={credentialPrefixes}
            row={snapshot}
            onSubmit={save}
            onOpenChange={setOpen}
            returnFocusRef={trigger}
          />
        ) : (
          <ProviderDeleteDialog
            credentialPrefixes={credentialPrefixes}
            row={snapshot}
            onDelete={remove}
            onOpenChange={setOpen}
            returnFocusRef={trigger}
          />
        )
      ) : null}
    </>
  );
}

async function open(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "열기" }));
  return screen.findByRole("dialog");
}

async function review(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
  await acknowledge(user);
  return screen.findByRole("table", { name: "공급자 변경 전후 비교" });
}

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("공급자 삭제 재확인", () => {
  it.each(["corp_", "%41_"])(
    "현재 %s 접두어로 비밀 이름을 재검사해 전체 참조만 표시하고 전송한다",
    async (prefix) => {
      const user = userEvent.setup();
      const credential = `${prefix}${"B".repeat(32)}`;
      const original = catalogRow({ ...provider, name: credential });
      const remove = vi.fn(async () => undefined);
      render(<Harness mode="delete" snapshot={original} remove={remove} credentialPrefixes={[prefix]} />);
      const dialog = await open(user);
      expect(dialog.innerHTML).not.toContain("B".repeat(32));
      expect(dialog).toHaveTextContent(original.identity);
      await user.type(within(dialog).getByLabelText("삭제 대상 재입력"), original.identity);
      await acknowledge(user);
      await user.click(within(dialog).getByRole("button", { name: "삭제" }));
      await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith(original.identity));
    },
  );

  it("비공개 표시명·축약 참조·공백은 거부하고 전체 참조만 전송한다", async () => {
    const user = userEvent.setup();
    const hidden = catalogRow({ ...provider, name: "[provider-name-omitted]" });
    const remove = vi.fn(async () => undefined);
    render(<Harness mode="delete" snapshot={hidden} remove={remove} />);
    const dialog = await open(user);
    const input = within(dialog).getByLabelText("삭제 대상 재입력");
    const confirm = within(dialog).getByRole("button", { name: "삭제" });
    for (const invalid of [
      hidden.displayName,
      hidden.identity.slice(-8),
      ` ${hidden.identity}`,
      `${hidden.identity} `,
    ]) {
      await user.clear(input);
      await user.type(input, invalid);
      expect(confirm).toBeDisabled();
      fireEvent.submit(formOf(input));
      expect(remove).not.toHaveBeenCalled();
    }
    await user.clear(input);
    await user.type(input, hidden.identity);
    await acknowledge(user);
    await user.click(confirm);
    await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith(hidden.identity));
  });

  it.each(["취소", "Escape"])("%s 후 원래 버튼으로 돌아가고 재열 때 재입력을 지운다", async (method) => {
    const user = userEvent.setup();
    const remove = vi.fn(async () => undefined);
    render(<Harness mode="delete" remove={remove} />);
    await open(user);
    await user.type(screen.getByLabelText("삭제 대상 재입력"), provider.name);
    if (method === "Escape") await user.keyboard("{Escape}");
    else await user.click(screen.getByRole("button", { name: method }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "열기" })).toHaveFocus();
    expect(remove).not.toHaveBeenCalled();
    await open(user);
    expect(screen.getByLabelText("삭제 대상 재입력")).toHaveValue("");
  });

  it("동일 tick 제출은 한 번이고 pending 잠금·실패 후 재시도가 동작한다", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const remove = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(undefined);
    render(<Harness mode="delete" remove={remove} />);
    await open(user);
    const input = screen.getByLabelText("삭제 대상 재입력");
    await user.type(input, provider.name);
    await acknowledge(user);
    act(() => {
      fireEvent.submit(formOf(input));
      fireEvent.submit(formOf(input));
    });
    expect(remove).toHaveBeenCalledTimes(1);
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => pending.reject(apiFailure("synthetic failure")));
    expect(await screen.findByRole("alert")).toHaveTextContent("req_test");
    expect(input).toBeEnabled();
    expect(input).toHaveValue(provider.name);
    await acknowledge(user);
    await user.click(screen.getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it.each(["resolve", "reject"])("로그아웃 후 늦은 %s가 새 확인창을 닫거나 덮지 않는다", async (outcome) => {
    const user = userEvent.setup();
    const pending = deferred();
    const remove = vi.fn(() => pending.promise);
    render(<Harness mode="delete" remove={remove} />);
    await open(user);
    await user.type(screen.getByLabelText("삭제 대상 재입력"), provider.name);
    await acknowledge(user);
    await user.click(screen.getByRole("button", { name: "삭제" }));
    act(() => {
      tokenStore.clearAll();
      publishLogout();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await open(user);
    await user.type(screen.getByLabelText("삭제 대상 재입력"), "new confirmation");
    await act(async () =>
      outcome === "resolve" ? pending.resolve(undefined) : pending.reject(apiFailure("old failure")),
    );
    expect(screen.getByLabelText("삭제 대상 재입력")).toHaveValue("new confirmation");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("공급자 수정 검토", () => {
  it("비밀값은 비교에 표시하지 않고 검토한 정규화 payload만 보낸다", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => undefined);
    render(<Harness save={save} />);
    await open(user);
    const url = "https://user:url-password@public.example/v2?api_key=url-secret#private-fragment";
    await user.clear(screen.getByLabelText(/^기본 URL/));
    await user.type(screen.getByLabelText(/^기본 URL/), url);
    await user.type(screen.getByLabelText("API 키"), "synthetic-secret-for-provider");
    await user.clear(screen.getByLabelText("우선순위"));
    await user.type(screen.getByLabelText("우선순위"), "025");
    const table = await review(user);
    expect(table).toHaveTextContent("교체");
    for (const secret of [
      "url-password",
      "url-secret",
      "private-fragment",
      "synthetic-secret-for-provider",
    ]) {
      expect(screen.getByRole("dialog").outerHTML).not.toContain(secret);
      expect(window.localStorage.length).toBe(0);
      expect(window.sessionStorage.length).toBe(0);
    }
    expect(save).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "검토한 내용 저장" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledExactlyOnceWith({
        name: provider.name,
        base_url: url,
        api_key: "synthetic-secret-for-provider",
        timeout_ms: 30000,
        model_patterns: "public-*",
        failover_group: "public-group",
        priority: 25,
        enabled: true,
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await open(user);
    expect(screen.getByLabelText("API 키")).toHaveValue("");
  });

  it("다시 편집하면 이전 승인을 없애고 새 값을 재검토한다", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async (body: ProviderWriteBody) => body);
    render(<Harness save={save} />);
    await open(user);
    await user.type(screen.getByLabelText("모델 패턴"), ",review-one");
    await review(user);
    await user.click(screen.getByRole("button", { name: "다시 편집" }));
    expect(screen.queryByRole("button", { name: "검토한 내용 저장" })).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^기본 URL/)).toHaveFocus();
    await user.clear(screen.getByLabelText("모델 패턴"));
    await user.type(screen.getByLabelText("모델 패턴"), "review-two");
    const table = await review(user);
    expect(table).toHaveTextContent("review-two");
    expect(table).not.toHaveTextContent("review-one");
    expect(save).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "검토한 내용 저장" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0]?.[0]).toMatchObject({ model_patterns: "review-two", api_key: undefined });
  });

  it("검토 도중 재조회가 열린 기준이나 승인 payload를 바꾸지 않는다", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async (body: ProviderWriteBody) => body);
    const view = render(<Harness save={save} />);
    await open(user);
    await user.clear(screen.getByLabelText("우선순위"));
    await user.type(screen.getByLabelText("우선순위"), "30");
    await review(user);
    const next = catalogRow({ ...provider, priority: 99 });
    view.rerender(<Harness snapshot={next} save={save} />);
    const priority = screen.getByRole("row", { name: /우선순위/ });
    expect(priority).toHaveTextContent("10");
    expect(priority).toHaveTextContent("30");
    expect(priority).not.toHaveTextContent("99");
    await user.click(screen.getByRole("button", { name: "검토한 내용 저장" }));
    await waitFor(() => expect(save.mock.calls[0]?.[0]).toMatchObject({ priority: 30 }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await open(user);
    expect(screen.getByLabelText("우선순위")).toHaveValue("99");
  });

  it("저장 pending 단일 실행과 실패 후 검토 초안 보존을 유지한다", async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const save = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(undefined);
    render(<Harness save={save} />);
    await open(user);
    await user.type(screen.getByLabelText("모델 패턴"), ",pending");
    await review(user);
    const form = formOf(screen.getByRole("table"));
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "다시 편집" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    await act(async () => pending.reject(apiFailure("synthetic failure")));
    expect(await screen.findByRole("alert")).toHaveTextContent("req_test");
    expect(screen.getByRole("table")).toHaveTextContent("public-*,pending");
    await acknowledge(user);
    await user.click(screen.getByRole("button", { name: "검토한 내용 저장" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[0]).toEqual(save.mock.calls[1]);
  });

  it("필수값 오류는 검토·저장하지 않고 활성 입력에 포커스를 돌린다", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => undefined);
    render(<Harness save={save} />);
    await open(user);
    const url = screen.getByLabelText(/^기본 URL/);
    await user.clear(url);
    await user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    expect(await screen.findByText("기본 URL을 입력하세요.")).toBeInTheDocument();
    await waitFor(() => {
      expect(url).toBeEnabled();
      expect(url).toHaveFocus();
    });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });

  it("검토 초안의 Escape·beforeunload를 보호하고 폐기하면 비밀을 지운다", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await open(user);
    await user.type(screen.getByLabelText("API 키"), "draft-private-value");
    await review(user);
    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    await user.keyboard("{Escape}");
    await user.click(await screen.findByRole("button", { name: "계속 편집" }));
    expect(screen.getByRole("table")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "취소" }));
    await user.click(await screen.findByRole("button", { name: "변경 버리기" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "열기" })).toHaveFocus();
    await open(user);
    expect(screen.getByLabelText("API 키")).toHaveValue("");
  });

  it.each(["resolve", "reject"])("이전 세션 저장의 늦은 %s는 새 폼에 영향이 없다", async (outcome) => {
    const user = userEvent.setup();
    const pending = deferred();
    const save = vi.fn(() => pending.promise);
    render(<Harness save={save} />);
    await open(user);
    await user.type(screen.getByLabelText("API 키"), "old-private-draft");
    await review(user);
    await user.click(screen.getByRole("button", { name: "검토한 내용 저장" }));
    act(() => {
      tokenStore.clearAll();
      publishLogout();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await open(user);
    expect(screen.getByLabelText("API 키")).toHaveValue("");
    await user.type(screen.getByLabelText("모델 패턴"), ",new-session");
    await act(async () =>
      outcome === "resolve" ? pending.resolve(undefined) : pending.reject(apiFailure("old failure")),
    );
    expect(screen.getByLabelText("모델 패턴")).toHaveValue("public-*,new-session");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  });

  it("실제 data router의 query 이동은 검토 초안 폐기 확인을 거친다", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          element: (
            <UnsavedChangesProvider blockNavigation>
              <Outlet />
            </UnsavedChangesProvider>
          ),
          children: [{ path: "/providers", element: <Harness /> }],
        },
      ],
      { initialEntries: ["/providers"] },
    );
    render(<RouterProvider router={router} />);
    await open(user);
    await user.type(screen.getByLabelText("모델 패턴"), ",draft");
    await review(user);
    await act(async () => {
      await router.navigate("/providers?q=changed");
    });
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "계속 편집" }));
    expect(router.state.location.search).toBe("");
    expect(screen.getByRole("table")).toHaveTextContent("public-*,draft");
    await act(async () => {
      await router.navigate("/providers?q=changed");
    });
    await user.click(await screen.findByRole("button", { name: "변경 버리기" }));
    await waitFor(() => expect(router.state.location.search).toBe("?q=changed"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    router.dispose();
  });

  it("검토 표와 삭제 확인창에 자동 접근성 위반이 없다", async () => {
    const user = userEvent.setup();
    const view = render(<Harness />);
    await open(user);
    await review(user);
    expect((await axe.run(screen.getByRole("dialog"))).violations).toEqual([]);
    view.unmount();
    render(<Harness mode="delete" />);
    await open(user);
    expect((await axe.run(screen.getByRole("dialog"))).violations).toEqual([]);
  });
});
