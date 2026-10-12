import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Text2SqlEmergencyPanel } from "./Text2SqlEmergencyPanel";
import { createAppQueryClient } from "@/app/providers/query-client";
import { ApiClient, apiClient } from "@/shared/api/client";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import type * as ConfirmationModule from "@/shared/components/ui/ConfirmDialog";

const callbacks = vi.hoisted(() => ({
  confirm: undefined as ((reason: string, target?: string) => unknown) | undefined,
}));
const identity = vi.hoisted(() => ({ id: "public-owner-a", team: "public-team-a" }));
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notifications }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ user: { id: identity.id, team_id: identity.team } }) };
});
vi.mock("@/shared/components/ui/ConfirmDialog", async (actualModule) => {
  const actual = await actualModule<typeof ConfirmationModule>();
  return {
    ConfirmDialog: (props: Parameters<typeof actual.ConfirmDialog>[0]) => {
      if (props.open) callbacks.confirm = props.onConfirm;
      return <actual.ConfirmDialog {...props} />;
    },
  };
});

const prefix = ["text2sql", "kill-switch"] as const;
const clients: QueryClient[] = [];
const reason = "공개 합성 검토 사유";
const target = "Text2SQL 처리 중지";
const base = {
  disabled: false,
  config_enabled: true,
  scope: "responding_process",
  instance_ref: "process_0123456789abcdef",
  review_token: "0123456789abcdef0123456789abcdef",
  observed_at: "2026-10-12T00:00:00Z",
};
const ack = { ...base, disabled: true, reason, review_token: "abcdef0123456789abcdef0123456789" };
type State = "running" | "stopped" | "denied" | "unavailable" | "pending";

function mount(state: State = "running") {
  let readOnly = false;
  let reply = (): Response | Promise<Response> => Response.json(ack);
  const attempts: { method: string; path: string }[] = [];
  const transport = new ApiClient({
    getAccessToken: () => "public-synthetic-access",
    getRefreshToken: () => "public-synthetic-refresh",
    fetch: vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input), "http://emergency-lifetime.invalid").pathname;
      const method = init?.method ?? "GET";
      attempts.push({ method, path });
      if (path !== "/admin/text2sql/kill-switch") throw new Error("Unexpected synthetic endpoint");
      if (method === "POST") return reply();
      if (state === "pending")
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      if (state === "denied" || state === "unavailable")
        return Response.json(
          { error: { message: "Public read failure" } },
          { status: state === "denied" ? 403 : 503 },
        );
      return Response.json({ ...base, disabled: state === "stopped" });
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
        <FeatureAccessContext.Provider value={{ featureId: "text2sql.overview", permitted: true, readOnly }}>
          <Text2SqlEmergencyPanel canWrite />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    client,
    attempts,
    posts: () => attempts.filter((a) => a.method === "POST" && a.path === "/admin/text2sql/kill-switch"),
    rerender: () => view.rerender(tree()),
    setReadOnly: () => {
      readOnly = true;
      view.rerender(tree());
    },
    reply: (next: typeof reply) => {
      reply = next;
    },
    nextRead: (next: State) => {
      state = next;
    },
    refetch: () => client.refetchQueries({ queryKey: prefix }),
  };
}

async function review() {
  const user = userEvent.setup();
  const button = screen.getByRole("button", { name: `${target} 검토` });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
  await user.type(screen.getByRole("textbox", { name: "변경 사유" }), reason);
  await user.type(screen.getByRole("textbox", { name: "확인 문구" }), target);
  const confirm = callbacks.confirm;
  if (!confirm) throw new Error("Missing live consent callback");
  return { user, confirm };
}

beforeEach(() => {
  identity.id = "public-owner-a";
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

describe("Text2SQL emergency consent and response lifetime", () => {
  it.each([
    "denied",
    "malformed",
    "wrong-process",
    "wrong-state",
    "same-revision",
    "missing-revision",
  ] as const)("does not refresh, replay or accept a %s acknowledgment", async (outcome) => {
    const gateway = mount();
    gateway.reply(() => {
      if (outcome === "denied")
        return Response.json({ error: { message: "Public expired session" } }, { status: 401 });
      if (outcome === "malformed") return Response.json({ disabled: "unknown" });
      return Response.json({
        ...ack,
        ...(outcome === "wrong-process" ? { instance_ref: "process_abcdef0123456789" } : {}),
        ...(outcome === "wrong-state" ? { disabled: false } : {}),
        ...(outcome === "same-revision" ? { review_token: base.review_token } : {}),
        ...(outcome === "missing-revision" ? { review_token: undefined } : {}),
      });
    });
    const { user, confirm } = await review();
    await user.click(screen.getByRole("button", { name: "중지" }));
    expect(await screen.findByText("처리 결과 확인이 필요합니다.")).toBeVisible();
    await act(async () => {
      await Promise.resolve(confirm(reason, target)).catch(() => undefined);
    });
    expect(gateway.posts()).toHaveLength(1);
    expect(gateway.attempts.filter((a) => a.path === "/auth/refresh")).toEqual([]);
    expect(notifications.success).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "중지" })).toBeDisabled();
  });

  it.each(["id", "team"] as const)("drops consent when the same-session %s changes", async (field) => {
    const gateway = mount();
    const { confirm } = await review();
    identity[field] = "public-new-owner";
    gateway.rerender();
    await act(async () => {
      await Promise.resolve(confirm(reason, target)).catch(() => undefined);
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(gateway.posts()).toEqual([]);
  });

  it.each(["success", "failure", "malformed"] as const)(
    "isolates a late %s from the new account's draft",
    async (outcome) => {
      const gateway = mount();
      let release: (response: Response) => void = () => {
        throw new Error("Missing held response");
      };
      const response = new Promise<Response>((resolve) => {
        release = resolve;
      });
      gateway.reply(() => response);
      const { user } = await review();
      await user.click(screen.getByRole("button", { name: "중지" }));
      await waitFor(() => expect(gateway.posts()).toHaveLength(1));
      identity.id = "public-owner-b";
      gateway.rerender();
      const next = await review();
      await next.user.clear(screen.getByRole("textbox", { name: "변경 사유" }));
      await next.user.type(screen.getByRole("textbox", { name: "변경 사유" }), "새 사용자의 사유");
      release(
        outcome === "success"
          ? Response.json(ack)
          : outcome === "failure"
            ? Response.json({}, { status: 503 })
            : Response.json({ disabled: "unknown" }),
      );
      await waitFor(() => expect(gateway.client.isMutating()).toBe(0));
      expect(notifications.success).not.toHaveBeenCalled();
      expect(screen.getByRole("textbox", { name: "변경 사유" })).toHaveValue("새 사용자의 사유");
      expect(gateway.posts()).toHaveLength(1);
    },
  );

  it("does not revive consent through A-B-A identity changes", async () => {
    const gateway = mount();
    const { confirm } = await review();
    for (const id of ["public-owner-b", "public-owner-a"]) {
      identity.id = id;
      gateway.rerender();
      await waitFor(() => expect(screen.getByRole("button", { name: `${target} 검토` })).toBeEnabled());
    }
    await review();
    await act(async () => {
      await Promise.resolve(confirm(reason, target)).catch(() => undefined);
    });
    expect(gateway.posts()).toEqual([]);
  });

  it("blocks a captured callback after migration becomes read-only", async () => {
    const gateway = mount();
    const { confirm } = await review();
    gateway.setReadOnly();
    await act(async () => {
      await Promise.resolve(confirm(reason, target)).catch(() => undefined);
    });
    expect(gateway.posts()).toEqual([]);
    expect(screen.getByRole("button", { name: "중지" })).toBeDisabled();
  });

  it("keeps acknowledged success when the following state read fails", async () => {
    const gateway = mount();
    gateway.reply(() => {
      gateway.nextRead("unavailable");
      return Response.json(ack);
    });
    const { user } = await review();
    await user.click(screen.getByRole("button", { name: "중지" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument(), { timeout: 5000 });
    expect(notifications.success).toHaveBeenCalledTimes(1);
    expect(gateway.posts()).toHaveLength(1);
    expect(screen.getByRole("button", { name: `${target} 검토` })).toBeDisabled();
    expect(screen.getByText("마지막 확인: 긴급 중지 해제")).toBeVisible();
  });

  it("labels the stopped state as stale after a denied read", async () => {
    const gateway = mount("stopped");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Text2SQL 처리 재개 검토" })).toBeEnabled(),
    );
    gateway.nextRead("denied");
    await act(async () => {
      await gateway.refetch();
    });
    expect(screen.getByText("마지막 확인: 처리 중지")).toBeVisible();
    expect(screen.queryByText("처리 중지", { exact: true })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Text2SQL 처리 재개 검토" })).toBeDisabled();
  });

  it.each(["replace", "cancel", "remove"] as const)(
    "cannot reuse consent after query %s",
    async (operation) => {
      const gateway = mount();
      const { confirm } = await review();
      const query = gateway.client.getQueryCache().find({ queryKey: prefix, exact: false });
      if (!query) throw new Error("Missing owner-scoped state query");
      if (operation === "replace")
        act(() => {
          gateway.client.setQueryData(query.queryKey, { ...base, disabled: true });
        });
      else if (operation === "remove")
        act(() => {
          gateway.client.removeQueries({ queryKey: query.queryKey, exact: true });
        });
      else {
        gateway.nextRead("pending");
        let pending: Promise<void> | undefined;
        act(() => {
          pending = gateway.refetch();
        });
        await waitFor(() => expect(query.state.fetchStatus).toBe("fetching"));
        await act(async () => {
          await gateway.client.cancelQueries({ queryKey: query.queryKey, exact: true });
          await pending;
        });
      }
      await act(async () => {
        await Promise.resolve(confirm(reason, target)).catch(() => undefined);
      });
      expect(gateway.posts()).toEqual([]);
      expect(screen.getByRole("button", { name: "중지" })).toBeDisabled();
    },
  );
});
