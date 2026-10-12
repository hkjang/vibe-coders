import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { KillSwitchSection } from "./KillSwitchSection";
import { createAppQueryClient } from "@/app/providers/query-client";
import { ApiClient, apiClient } from "@/shared/api/client";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import type * as ConfirmationModule from "@/shared/components/ui/ConfirmDialog";
import { tokenStore } from "@/shared/auth/token-store";

const callbacks = vi.hoisted(() => ({
  confirm: undefined as ((reason: string, target?: string) => unknown) | undefined,
}));
const identity = vi.hoisted(() => ({ id: "public-operator-a", team: "public-team-a" }));
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notifications }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ user: { id: identity.id, team_id: identity.team } }) };
});
vi.mock("@/shared/components/ui/ConfirmDialog", async (importActual) => {
  const actual = await importActual<typeof ConfirmationModule>();
  return {
    ConfirmDialog: (props: Parameters<typeof actual.ConfirmDialog>[0]) => {
      if (props.open) callbacks.confirm = props.onConfirm;
      return <actual.ConfirmDialog {...props} />;
    },
  };
});

const clients: QueryClient[] = [];
const stopLabel = "새 요청 긴급 차단";
const reason = "공개 합성 검증용 장애 대응";
type State = "pending" | "error" | "unavailable" | "running" | "stopped";

function mount(state: State, canWrite = true) {
  let reply: (body: unknown) => Response | Promise<Response> = (body) => Response.json(body);
  const attempts: { method: string; path: string; body: unknown }[] = [];
  const transport = new ApiClient({
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input), "http://emergency-review.invalid").pathname;
      const method = init?.method ?? "GET";
      const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      attempts.push({ method, path, body });
      if (path === "/admin/incidents" && method === "GET") return Response.json({ incidents: [] });
      if (path !== "/admin/kill-switch") throw new Error("Unexpected synthetic endpoint");
      if (method === "POST") return reply(body);
      if (state === "pending")
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      if (state === "error")
        return Response.json({ error: { message: "Public synthetic read denial" } }, { status: 403 });
      if (state === "unavailable")
        return Response.json(
          { error: { message: "Public state unavailable", code: "kill_switch_state_unavailable" } },
          { status: 503 },
        );
      return Response.json({
        disabled: state === "stopped",
        reason: "공개 기준 사유",
        updated_at: "2026-10-12T00:00:00Z",
        updated_by: "public-operator",
      });
    }),
  });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  const client = createAppQueryClient();
  clients.push(client);
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FeatureAccessContext.Provider
          value={{ featureId: "governance.policies", permitted: true, readOnly: false }}
        >
          <KillSwitchSection canWrite={canWrite} />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    client,
    posts: () => attempts.filter((attempt) => attempt.method === "POST"),
    rerender: () => view.rerender(tree()),
    nextReadState: (next: State) => {
      state = next;
    },
    reply: (handler: typeof reply) => {
      reply = handler;
    },
    changeState: async (next: State) => {
      state = next;
      await client.refetchQueries({ queryKey: ["governance", "kill-switch"] });
    },
  };
}

beforeEach(() => {
  identity.id = "public-operator-a";
  identity.team = "public-team-a";
  notifications.success.mockClear();
  notifications.error.mockClear();
});

afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  vi.restoreAllMocks();
  callbacks.confirm = undefined;
});

describe("게이트웨이 긴급 정지의 상태 확인과 대상 재입력", () => {
  it("정지 상태 재조회 실패는 마지막 확인으로 구분하고 현재 차단을 보장하지 않는다", async () => {
    const gateway = mount("stopped");
    await waitFor(() => expect(screen.getByRole("button", { name: "정상 운영 재개" })).toBeEnabled());
    expect(screen.getByText("게이트웨이가 정지 상태입니다.")).toBeVisible();
    await act(async () => gateway.changeState("error"));
    expect(screen.getByText("마지막 확인: 정지 중")).toBeVisible();
    expect(screen.queryByText("게이트웨이가 정지 상태입니다.")).not.toBeInTheDocument();
    expect(screen.queryByText("정지 중", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "정상 운영 재개" })).toBeDisabled();
    expect(gateway.posts()).toEqual([]);
  });

  it("커밋 확인 후 상태 재조회가 실패해도 변경을 재전송하거나 실패로 뒤집지 않는다", async () => {
    const gateway = mount("running");
    gateway.reply((body) => {
      gateway.nextReadState("unavailable");
      return Response.json(body);
    });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole("button", { name: stopLabel })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: stopLabel }));
    await user.type(screen.getByRole("textbox", { name: "변경 사유" }), reason);
    await user.type(screen.getByRole("textbox", { name: "확인 문구" }), "게이트웨이 전체 정지");
    await user.click(screen.getByRole("button", { name: "긴급 차단" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 5000 });
    expect(gateway.posts()).toHaveLength(1);
    expect(notifications.success).toHaveBeenCalledTimes(1);
    expect(notifications.error).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: stopLabel })).toBeDisabled();
    expect(screen.queryByText("정상 운영", { exact: true })).not.toBeInTheDocument();
  });

  it.each(["replace", "cancel"] as const)(
    "%s 조회 이후 이전 승인 콜백을 재사용하지 않는다",
    async (operation) => {
      const gateway = mount("running");
      const user = userEvent.setup();
      await waitFor(() => expect(screen.getByRole("button", { name: stopLabel })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: stopLabel }));
      const captured = callbacks.confirm;
      if (!captured) throw new Error("Missing real callback");
      const query = gateway.client
        .getQueryCache()
        .find({ queryKey: ["governance", "kill-switch"], exact: false });
      if (!query) throw new Error("Missing owned query");
      if (operation === "replace") {
        act(() =>
          gateway.client.setQueryData(query.queryKey, { disabled: false, reason: "replacement baseline" }),
        );
      } else {
        gateway.nextReadState("pending");
        let pending: Promise<void> | undefined;
        act(() => {
          pending = gateway.client.refetchQueries({ queryKey: query.queryKey, exact: true });
        });
        await waitFor(() => expect(query.state.fetchStatus).toBe("fetching"));
        await act(async () => {
          await gateway.client.cancelQueries({ queryKey: query.queryKey, exact: true });
          await pending;
        });
      }
      await act(async () => {
        await Promise.resolve(captured(reason, "게이트웨이 전체 정지")).catch(() => undefined);
      });
      expect(gateway.posts()).toEqual([]);
      expect(screen.getByRole("button", { name: "긴급 차단" })).toBeDisabled();
    },
  );
  it("조회 중에는 알 수 없는 상태에서 변경 확인을 시작하지 않는다", async () => {
    const gateway = mount("pending");
    expect(screen.getByText("긴급 정지 상태를 확인하는 중입니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: stopLabel })).toBeDisabled();
    expect(gateway.posts()).toEqual([]);
  });

  it("최초 조회 거부를 정상 운영 상태로 표시하거나 변경을 허용하지 않는다", async () => {
    const gateway = mount("error");
    await waitFor(() =>
      expect(
        gateway.client.getQueryCache().find({ queryKey: ["governance", "kill-switch"], exact: false })?.state
          .status,
      ).toBe("error"),
    );
    expect(screen.queryByText("정상 운영", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: stopLabel })).toBeDisabled();
    expect(gateway.posts()).toEqual([]);
  });

  it.each(["running", "stopped"] as const)("%s 상태 변경은 사유만으로 확정할 수 없다", async (state) => {
    const gateway = mount(state);
    await waitFor(() =>
      expect(
        gateway.client.getQueryCache().find({ queryKey: ["governance", "kill-switch"], exact: false })?.state
          .status,
      ).toBe("success"),
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: state === "running" ? stopLabel : "정상 운영 재개" }),
    );
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/변경 사유/u), reason);
    expect(
      within(dialog).getByRole("button", {
        name: state === "running" ? "긴급 차단" : "운영 재개",
      }),
    ).toBeDisabled();
    expect(gateway.posts()).toEqual([]);
  });

  it("정상 조회 후에도 쓰기 권한 없는 사용자는 변경할 수 없다", async () => {
    const gateway = mount("running", false);
    await waitFor(() =>
      expect(
        gateway.client.getQueryCache().find({ queryKey: ["governance", "kill-switch"], exact: false })?.state
          .status,
      ).toBe("success"),
    );
    expect(screen.getByRole("button", { name: stopLabel })).toBeDisabled();
    expect(gateway.posts()).toEqual([]);
  });

  it.each(["running", "stopped"] as const)("%s의 정확한 대상 문구와 사유만 한 번 전송한다", async (state) => {
    const gateway = mount(state);
    await waitFor(() =>
      expect(
        gateway.client.getQueryCache().find({ queryKey: ["governance", "kill-switch"], exact: false })?.state
          .status,
      ).toBe("success"),
    );
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: state === "running" ? stopLabel : "정상 운영 재개" }),
    );
    const dialog = screen.getByRole("dialog");
    const target = within(dialog).getByRole("textbox", { name: "확인 문구" });
    const confirm = within(dialog).getByRole("button", {
      name: state === "running" ? "긴급 차단" : "운영 재개",
    });
    const expected = state === "running" ? "게이트웨이 전체 정지" : "게이트웨이 운영 재개";
    await user.type(within(dialog).getByLabelText(/변경 사유/u), reason);
    await user.type(target, `${expected} `);
    expect(confirm).toBeDisabled();
    expect(gateway.posts()).toEqual([]);
    await user.clear(target);
    await user.type(target, expected);
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() =>
      expect(gateway.posts()).toEqual([
        { method: "POST", path: "/admin/kill-switch", body: { disabled: state === "running", reason } },
      ]),
    );
  });

  it("같은 상태를 재조회해도 이전 검토 승인으로 전송하지 않는다", async () => {
    const gateway = mount("running");
    await waitFor(() =>
      expect(
        gateway.client.getQueryCache().find({ queryKey: ["governance", "kill-switch"], exact: false })?.state
          .status,
      ).toBe("success"),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: stopLabel }));
    const captured = callbacks.confirm;
    if (!captured) throw new Error("Missing real callback");
    await act(() => gateway.changeState("running"));
    await act(async () => {
      await Promise.resolve(captured(reason, "게이트웨이 전체 정지")).catch(() => undefined);
    });
    expect(gateway.posts()).toEqual([]);
  });

  it("닫았다 같은 대상으로 다시 연 뒤 이전 확인 콜백은 새 검토를 전송하지 않는다", async () => {
    const gateway = mount("running");
    await waitFor(() =>
      expect(
        gateway.client.getQueryCache().find({ queryKey: ["governance", "kill-switch"], exact: false })?.state
          .status,
      ).toBe("success"),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: stopLabel }));
    const captured = callbacks.confirm;
    if (!captured) throw new Error("Missing real callback");
    await user.click(screen.getByRole("button", { name: "취소" }));
    await user.click(screen.getByRole("button", { name: stopLabel }));
    await act(async () => {
      await Promise.resolve(captured(reason, "게이트웨이 전체 정지")).catch(() => undefined);
    });
    expect(gateway.posts()).toEqual([]);
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("잘못된 상태 응답은 성공으로 닫거나 같은 확인에서 재전송하지 않는다", async () => {
    const gateway = mount("running");
    gateway.reply(() => Response.json({ disabled: false, reason }));
    await waitFor(() =>
      expect(
        gateway.client.getQueryCache().find({ queryKey: ["governance", "kill-switch"], exact: false })?.state
          .status,
      ).toBe("success"),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: stopLabel }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText(/변경 사유/u), reason);
    await user.type(within(dialog).getByRole("textbox", { name: "확인 문구" }), "게이트웨이 전체 정지");
    const captured = callbacks.confirm;
    if (!captured) throw new Error("Missing real callback");
    await user.click(within(dialog).getByRole("button", { name: "긴급 차단" }));
    await waitFor(() => expect(gateway.posts()).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByRole("dialog")).toHaveTextContent("변경 결과를 확인하지 못했습니다"),
    );
    await act(async () => {
      await Promise.resolve(captured(reason, "게이트웨이 전체 정지")).catch(() => undefined);
    });
    expect(gateway.posts()).toHaveLength(1);
  });

  it.each(["id", "team"] as const)(
    "같은 세션의 %s 변경 뒤 이전 사유와 확인을 새 사용자에게 넘기지 않는다",
    async (field) => {
      const gateway = mount("running");
      await waitFor(() =>
        expect(
          gateway.client.getQueryCache().find({ queryKey: ["governance", "kill-switch"], exact: false })
            ?.state.status,
        ).toBe("success"),
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: stopLabel }));
      await user.type(screen.getByRole("textbox", { name: "변경 사유" }), reason);
      const captured = callbacks.confirm;
      if (!captured) throw new Error("Missing real callback");
      const epoch = tokenStore.getSessionEpoch();
      identity[field] = "public-owner-b";
      gateway.rerender();
      expect(tokenStore.getSessionEpoch()).toBe(epoch);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await act(async () => {
        await Promise.resolve(captured(reason, "게이트웨이 전체 정지")).catch(() => undefined);
      });
      expect(gateway.posts()).toEqual([]);
    },
  );

  it.each(["success", "failure", "malformed"] as const)(
    "계정 변경 뒤 늦은 %s 응답이 새 확인창과 알림에 영향을 주지 않는다",
    async (outcome) => {
      const gateway = mount("running");
      let release: (response: Response) => void = () => {
        throw new Error("Missing deferred reply");
      };
      const response = new Promise<Response>((resolve) => {
        release = resolve;
      });
      gateway.reply(() => response);
      await waitFor(() =>
        expect(
          gateway.client.getQueryCache().find({ queryKey: ["governance", "kill-switch"], exact: false })
            ?.state.status,
        ).toBe("success"),
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: stopLabel }));
      await user.type(screen.getByRole("textbox", { name: "변경 사유" }), reason);
      await user.type(screen.getByRole("textbox", { name: "확인 문구" }), "게이트웨이 전체 정지");
      await user.click(screen.getByRole("button", { name: "긴급 차단" }));
      await waitFor(() => expect(gateway.posts()).toHaveLength(1));
      const epoch = tokenStore.getSessionEpoch();
      identity.id = "public-operator-b";
      gateway.rerender();
      await waitFor(() => expect(screen.getByRole("button", { name: stopLabel })).toBeEnabled());
      await user.click(screen.getByRole("button", { name: stopLabel }));
      await user.type(screen.getByRole("textbox", { name: "변경 사유" }), "새 사용자의 공개 사유");
      release(
        outcome === "success"
          ? Response.json({ disabled: true, reason })
          : outcome === "failure"
            ? Response.json({ error: { message: "Public failure" } }, { status: 503 })
            : Response.json({ disabled: "unknown" }),
      );
      await waitFor(() => expect(gateway.client.isMutating()).toBe(0));
      expect(tokenStore.getSessionEpoch()).toBe(epoch);
      expect(notifications.success).not.toHaveBeenCalled();
      expect(notifications.error).not.toHaveBeenCalled();
      expect(gateway.posts()).toHaveLength(1);
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(screen.getByRole("textbox", { name: "변경 사유" })).toHaveValue("새 사용자의 공개 사유");
    },
  );

  it("A → B → A 계정 전환 후 이전 A의 확인 콜백도 폐기한다", async () => {
    const gateway = mount("running");
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByRole("button", { name: stopLabel })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: stopLabel }));
    const captured = callbacks.confirm;
    if (!captured) throw new Error("Missing real callback");
    for (const id of ["public-operator-b", "public-operator-a"]) {
      identity.id = id;
      gateway.rerender();
      await waitFor(() => expect(screen.getByRole("button", { name: stopLabel })).toBeEnabled());
    }
    await user.click(screen.getByRole("button", { name: stopLabel }));
    await act(async () => {
      await Promise.resolve(captured(reason, "게이트웨이 전체 정지")).catch(() => undefined);
    });
    expect(gateway.posts()).toEqual([]);
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "변경 사유" })).toHaveValue("");
  });
});
