import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { AuthProvider } from "@/app/auth/AuthProvider";
import { createAppQueryClient } from "@/app/providers/query-client";
import { apiClient } from "@/shared/api/client";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessHarness } from "@/test/feature-access";
import { useLLMReadOwner, type LLMReadOwner } from "./llm-read-access";
import { llmReadQueryOptions } from "./llm-read-query";

afterEach(() => {
  cleanup();
  tokenStore.clearAll();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("commits authorized initial and replacement reads before their deferred DOM notification", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const client = createAppQueryClient();
  const events: string[] = [];
  const bootstrap = (id: string) => ({
    capabilities: { raw_prompt_view: true },
    authentication: { enabled: true, authenticated: true, mode: "session" },
    user: { id, role: "admin", roles: ["admin"], scopes: ["admin:read"], features: {} },
    ui: { enabled: true },
    migration_registry: [],
  });
  const request = vi.spyOn(apiClient, "request").mockResolvedValue(bootstrap("public-owner-a"));
  function Child({ owner }: { owner: LLMReadOwner }) {
    const query = useQuery({
      ...llmReadQueryOptions(owner, ["observability", "llm", "test"], async () => {
        events.push(`request:${owner.isCurrent()}`);
        return "authorized result";
      }),
      retry: false,
    });
    useLayoutEffect(() => {
      events.push(`child-layout:${owner.isCurrent()}`);
    }, [owner]);
    return <output>{query.data ?? query.status}</output>;
  }
  function Owner() {
    const owner = useLLMReadOwner();
    return owner.readable ? <Child key={owner.id} owner={owner} /> : <output>authorizing</output>;
  }
  render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <FeatureAccessHarness featureId="observability.llm">
          <Owner />
        </FeatureAccessHarness>
      </AuthProvider>
    </QueryClientProvider>,
  );
  await act(async () => vi.advanceTimersByTimeAsync(100));
  const state = () => ({
    events: [...events],
    queries: client
      .getQueryCache()
      .getAll()
      .map((query) => ({
        status: query.state.status,
        fetchStatus: query.state.fetchStatus,
        data: query.state.data,
        error: query.state.error?.message,
      })),
    displayed: screen.getByRole("status").textContent,
  });
  const successfulQuery = {
    status: "success",
    fetchStatus: "idle",
    data: "authorized result",
    error: undefined,
  };
  expect(state()).toEqual({
    events: ["child-layout:false", "request:true"],
    queries: [successfulQuery],
    displayed: "pending",
  });
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByRole("status")).toHaveTextContent("authorized result");
  const oldQuery = client.getQueryCache().getAll()[0];
  request.mockResolvedValue(bootstrap("public-owner-b"));
  fireEvent(document, new Event("visibilitychange"));
  await act(async () => vi.advanceTimersByTimeAsync(100));
  expect(state()).toEqual({
    events: ["child-layout:false", "request:true", "child-layout:false", "request:true"],
    queries: [successfulQuery],
    displayed: "pending",
  });
  expect(client.getQueryCache().getAll()).not.toContain(oldQuery);
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByRole("status")).toHaveTextContent("authorized result");
  client.clear();
});
