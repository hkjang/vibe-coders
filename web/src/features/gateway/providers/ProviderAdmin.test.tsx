import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderPage } from "@/features/gateway/providers/ProviderPage";
import { providerImpactAcknowledgement } from "@/features/gateway/providers/ProviderImpactPanel";
import { providerImpactFixture } from "@/features/gateway/providers/provider-impact-test-fixtures";
import type { Provider, ProviderList, ProviderSLOResponse } from "@/shared/api/schemas";
import { usePreferences } from "@/shared/stores/preferences";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({
  scopes: ["admin:read", "admin:write", "routing:read"],
  credentialPrefixes: ["vc_sk_", "vc_sa_"],
}));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ scopes: authRuntime.scopes }),
      credentialPrefixes: authRuntime.credentialPrefixes,
    }),
  };
});

const providerRef = (seed: string): string =>
  `prv_${[...seed]
    .map((character) => character.charCodeAt(0).toString(36))
    .join("")
    .padEnd(43, "x")
    .slice(0, 43)}`;

const openai = {
  name: "openai",
  provider_ref: providerRef("openai"),
  base_url: "https://api.openai.example/v1",
  api_key_configured: true,
  timeout_ms: 30_000,
  enabled: true,
  model_patterns: "gpt-*",
  failover_group: "premium",
  priority: 10,
  created_at: "2026-08-01T09:00:00Z",
} satisfies Provider;

const redacted = {
  ...openai,
  name: "[provider-name-omitted]",
  provider_ref: providerRef("hidden"),
  base_url: "https://hidden.example/v1",
  model_patterns: "hidden-*",
  priority: 20,
} satisfies Provider;

const providerList = { providers: [openai, redacted] } satisfies ProviderList;

const sloResponse = {
  slos: [],
  evaluations: [],
  since: "2026-09-01T00:00:00Z",
} satisfies ProviderSLOResponse;

function handlers() {
  return {
    "GET /admin/provider-impact": ({ query }: { query?: object }) =>
      providerImpactFixture((query as { provider_ref: string }).provider_ref),
    "GET /admin/providers": () => providerList,
    "GET /admin/providers/slo": () => sloResponse,
    "GET /admin/routing/health": () => ({
      since: "2026-09-01T00:00:00Z",
      until: "2026-09-02T00:00:00Z",
      threshold: 70,
      providers: [],
      ranking: [],
      degraded: [],
      alerts: [],
      trend: [],
      breakers: {
        enabled: true,
        threshold: 3,
        cooldown_seconds: 30,
        states: [],
        shared: false,
        instance_id: "gateway-1",
      },
    }),
  };
}

function renderProviders() {
  return renderScreen(<ProviderPage />, { path: "/gateway/providers", route: "/gateway/providers" });
}

async function acknowledge(user: ReturnType<typeof userEvent.setup>) {
  const checkbox = await screen.findByRole("checkbox", { name: new RegExp(providerImpactAcknowledgement) });
  await waitFor(() => expect(checkbox).toBeEnabled());
  await user.click(checkbox);
}

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "admin:write", "routing:read"];
  authRuntime.credentialPrefixes = ["vc_sk_", "vc_sa_"];
  usePreferences.setState({ refreshInterval: 0 });
});

describe("ProviderPage administration", () => {
  it("threads runtime authentication prefixes into edit review without mutating the submitted values", async () => {
    authRuntime.credentialPrefixes = ["corp_"];
    const secret = "corp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
    const baseURL = `https://review.example/v1?value=${secret}`;
    const user = userEvent.setup();
    const api = mockApi({ ...handlers(), "POST /admin/providers": () => ({ provider: { name: "openai" } }) });
    renderProviders();
    const row = (await screen.findByRole("link", { name: "openai" })).closest("tr");
    await user.click(within(row as HTMLElement).getByRole("button", { name: "수정" }));
    const dialog = await screen.findByRole("dialog");
    for (const [label, value] of [
      [/^기본 URL/u, baseURL],
      ["모델 패턴", secret],
      ["장애 전환 그룹", secret],
    ] as const) {
      const input = within(dialog).getByLabelText(label);
      await user.clear(input);
      await user.type(input, value);
    }
    await user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
    expect(within(dialog).getByRole("table", { name: "공급자 변경 전후 비교" })).not.toHaveTextContent(
      secret,
    );
    expect(dialog.innerHTML).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
    expect(api.bodies("POST /admin/providers")).toHaveLength(0);
    await acknowledge(user);
    await user.click(within(dialog).getByRole("button", { name: "검토한 내용 저장" }));
    await waitFor(() => expect(api.bodies("POST /admin/providers")).toHaveLength(1));
    expect(api.bodies("POST /admin/providers")[0]).toMatchObject({
      base_url: baseURL,
      model_patterns: secret,
      failover_group: secret,
    });
  });

  it("requires the exact deletion target before sending any request", async () => {
    const user = userEvent.setup();
    const api = mockApi({ ...handlers(), "DELETE /admin/providers/openai": () => ({ deleted: "openai" }) });
    renderProviders();
    const row = (await screen.findByRole("link", { name: "openai" })).closest("tr");
    await user.click(within(row as HTMLElement).getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog");
    const target = within(dialog).getByLabelText("삭제 대상 재입력");
    await user.type(target, "OpenAI");
    expect(within(dialog).getByRole("button", { name: "삭제" })).toBeDisabled();
    expect(api.calls.filter((call) => call.key.startsWith("DELETE "))).toHaveLength(0);
    await user.clear(target);
    await user.type(target, "openai");
    await acknowledge(user);
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    await waitFor(() => expect(api.calls.filter((call) => call.key.startsWith("DELETE "))).toHaveLength(1));
  });

  it("reviews an edit before saving the reviewed payload", async () => {
    const user = userEvent.setup();
    const api = mockApi({ ...handlers(), "POST /admin/providers": () => ({ provider: { name: "openai" } }) });
    renderProviders();
    const row = (await screen.findByRole("link", { name: "openai" })).closest("tr");
    await user.click(within(row as HTMLElement).getByRole("button", { name: "수정" }));
    const dialog = await screen.findByRole("dialog");
    await user.clear(within(dialog).getByLabelText("우선순위"));
    await user.type(within(dialog).getByLabelText("우선순위"), "25");
    await user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
    expect(api.bodies("POST /admin/providers")).toHaveLength(0);
    expect(within(dialog).getByRole("table", { name: "공급자 변경 전후 비교" })).toHaveTextContent("25");
    await acknowledge(user);
    await user.click(within(dialog).getByRole("button", { name: "검토한 내용 저장" }));
    await waitFor(() => expect(api.bodies("POST /admin/providers")).toHaveLength(1));
    expect(api.bodies("POST /admin/providers")[0]).toMatchObject({ name: "openai", priority: 25 });
  });

  it("creates a provider and never echoes the API key back", async () => {
    const user = userEvent.setup();
    const api = mockApi({ ...handlers(), "POST /admin/providers": () => ({ provider: { name: "azure" } }) });
    renderProviders();

    await screen.findByRole("link", { name: "openai" });
    await user.click(screen.getByRole("button", { name: /공급자 추가/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/^이름/), "azure");
    await user.type(within(dialog).getByLabelText(/^기본 URL/), "https://azure.example/v1");
    await user.type(within(dialog).getByLabelText("API 키"), "sk-secret-value");
    await user.type(within(dialog).getByLabelText("모델 패턴"), "gpt-*");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/providers")[0]).toMatchObject({
        name: "azure",
        base_url: "https://azure.example/v1",
        api_key: "sk-secret-value",
        model_patterns: "gpt-*",
        enabled: true,
      });
    });
    expect(window.location.search).not.toContain("sk-secret-value");
  });

  it("toggles a provider without resending its stored secret", async () => {
    const user = userEvent.setup();
    const api = mockApi({ ...handlers(), "POST /admin/providers": () => ({ provider: { name: "openai" } }) });
    renderProviders();

    const row = (await screen.findByRole("link", { name: "openai" })).closest("tr");
    await user.click(within(row as HTMLElement).getByRole("button", { name: "중지" }));
    expect(api.bodies("POST /admin/providers")).toHaveLength(0);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("checkbox", { name: /^활성/ })).not.toBeChecked();
    await user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
    await acknowledge(user);
    await user.click(within(dialog).getByRole("button", { name: "검토한 내용 저장" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/providers")[0]).toMatchObject({ name: "openai", enabled: false });
    });
    expect(api.bodies("POST /admin/providers")[0]).not.toHaveProperty("api_key", expect.any(String));
  });

  it("deletes a provider after confirmation", async () => {
    const user = userEvent.setup();
    const api = mockApi({ ...handlers(), "DELETE /admin/providers/openai": () => ({ deleted: "openai" }) });
    renderProviders();

    const row = (await screen.findByRole("link", { name: "openai" })).closest("tr");
    await user.click(within(row as HTMLElement).getByRole("button", { name: "삭제" }));

    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("삭제 대상 재입력"), "openai");
    await acknowledge(user);
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));

    await waitFor(() => {
      expect(api.calls.some((call) => call.key === "DELETE /admin/providers/openai")).toBe(true);
    });
  });

  it("saves an SLO target for a provider", async () => {
    const user = userEvent.setup();
    const api = mockApi({ ...handlers(), "POST /admin/providers/slo": () => ({ slo: {} }) });
    renderProviders();

    const row = (await screen.findByRole("link", { name: "openai" })).closest("tr");
    await user.click(within(row as HTMLElement).getByRole("button", { name: "SLO" }));

    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/providers/slo")[0]).toMatchObject({
        provider: "openai",
        availability_target: 0.99,
        enabled: true,
      });
    });
  });

  it("disables every write control without admin:write", async () => {
    authRuntime.scopes = ["admin:read", "routing:read"];
    mockApi(handlers());
    renderProviders();

    expect(await screen.findByRole("button", { name: /공급자 추가/ })).toBeDisabled();
    const row = (await screen.findByRole("link", { name: "openai" })).closest("tr");
    expect(within(row as HTMLElement).getByRole("button", { name: "수정" })).toBeDisabled();
  });

  it("blocks only the name-keyed edit for a redacted provider", async () => {
    mockApi(handlers());
    renderProviders();

    const hiddenRow = (await screen.findByText(/공급자 이름 비공개/)).closest("tr");
    // Saving is an upsert on the provider name, which a redacted row cannot supply.
    const edit = within(hiddenRow as HTMLElement).getByRole("button", { name: "수정" });
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute("title", expect.stringContaining("비공개"));
    expect(within(hiddenRow as HTMLElement).getByRole("button", { name: "중지" })).toBeDisabled();
    // Deleting and editing the SLO resolve the opaque reference server-side.
    expect(within(hiddenRow as HTMLElement).getByRole("button", { name: "삭제" })).toBeEnabled();
    expect(within(hiddenRow as HTMLElement).getByRole("button", { name: "SLO" })).toBeEnabled();
  });

  it("switching deletion targets resets confirmation and keeps opaque identity exact", async () => {
    const user = userEvent.setup();
    const api = mockApi({ ...handlers(), "DELETE /admin/providers/{name}": () => ({ deleted: "public" }) });
    renderProviders();
    const first = (await screen.findByRole("link", { name: "openai" })).closest("tr");
    await user.click(within(first as HTMLElement).getByRole("button", { name: "삭제" }));
    await user.type(screen.getByLabelText("삭제 대상 재입력"), "openai");
    await user.click(screen.getByRole("button", { name: "취소" }));
    const second = screen.getByText(/공급자 이름 비공개/).closest("tr");
    await user.click(within(second as HTMLElement).getByRole("button", { name: "삭제" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByLabelText("삭제 대상 재입력")).toHaveValue("");
    expect(within(dialog).getByText(providerRef("hidden"))).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("삭제 대상 재입력"), "openai");
    expect(within(dialog).getByRole("button", { name: "삭제" })).toBeDisabled();
    expect(api.calls.filter((call) => call.key.startsWith("DELETE "))).toHaveLength(0);
    await user.clear(within(dialog).getByLabelText("삭제 대상 재입력"));
    await user.type(within(dialog).getByLabelText("삭제 대상 재입력"), providerRef("hidden"));
    await acknowledge(user);
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    await waitFor(() =>
      expect(api.calls.filter((call) => call.key.startsWith("DELETE ")).map((call) => call.key)).toEqual([
        `DELETE /admin/providers/${providerRef("hidden")}`,
      ]),
    );
  });

  it("deletes a redacted provider by its opaque reference", async () => {
    const api = mockApi({
      ...handlers(),
      "DELETE /admin/providers/{name}": () => ({ deleted: "공급자 이름 비공개" }),
    });
    const user = userEvent.setup();
    renderProviders();

    const hiddenRow = (await screen.findByText(/공급자 이름 비공개/)).closest("tr");
    await user.click(within(hiddenRow as HTMLElement).getByRole("button", { name: "삭제" }));
    await user.type(await screen.findByLabelText("삭제 대상 재입력"), providerRef("hidden"));
    await acknowledge(user);
    await user.click(await screen.findByRole("button", { name: "삭제", hidden: false }));

    await waitFor(() =>
      expect(api.calls.some((call) => call.key === `DELETE /admin/providers/${providerRef("hidden")}`)).toBe(
        true,
      ),
    );
  });

  it("has no accessibility violations with the administration column", async () => {
    mockApi(handlers());
    const { container } = renderProviders();

    await screen.findByRole("link", { name: "openai" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
