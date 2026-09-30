import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as renderComponent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderEditDialog } from "@/features/gateway/providers/ProviderEditDialog";
import { providerImpactAcknowledgement } from "@/features/gateway/providers/ProviderImpactPanel";
import { buildProviderRows } from "@/features/gateway/providers/provider-catalog";
import { providerImpactFixture } from "@/features/gateway/providers/provider-impact-test-fixtures";
import {
  providerEditSchema,
  providerFormSchema,
  providerFormValues,
} from "@/features/gateway/providers/provider-form";
import { mockApi } from "@/test/api";
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
  await user.click(checkbox);
}

const redactedURL = "[invalid or redacted provider URL]";
const row = buildProviderRows([
  {
    name: "public-legacy",
    provider_ref: `prv_${"l".repeat(43)}`,
    base_url: redactedURL,
    api_key_configured: true,
    enabled: true,
    timeout_ms: 30000,
    model_patterns: "public-*",
    failover_group: "public-group",
    priority: 1,
    created_at: "2026-09-30T00:00:00Z",
  },
])[0];
if (!row) throw new Error("missing public legacy provider row");

describe("비공개 기존 URL 유지", () => {
  it.each([
    { name: "public legacy name" },
    { name: "p".repeat(210) },
    { timeout_ms: 900_000 },
    { priority: 200_000 },
    { model_patterns: "public-".repeat(300) },
    { failover_group: "public-".repeat(40) },
  ])("서버에 이미 있는 값을 유지하는 변경에는 생성 제약을 재적용하지 않는다: %j", (existing) => {
    const snapshot = {
      ...row,
      provider: { ...row.provider, base_url: "https://public.example/v1", ...existing },
    };
    const values = providerFormValues(snapshot);
    expect(providerFormSchema.safeParse(values).success).toBe(false);
    expect(providerEditSchema(snapshot).safeParse({ ...values, enabled: false }).success).toBe(true);
  });

  it("읽기 전용 이름을 바꾸거나 새 값을 상한 밖으로 바꾸는 것은 거절한다", () => {
    const schema = providerEditSchema(row);
    const values = providerFormValues(row);
    for (const change of [
      { name: "renamed" },
      { priority: "200000" },
      { timeout_ms: "900000" },
      { model_patterns: "public-".repeat(300) },
      { failover_group: "public-".repeat(40) },
    ])
      expect(schema.safeParse({ ...values, ...change }).success).toBe(false);
  });
  it("추가 또는 공개 주소 편집에서는 비공개 표시값을 새 주소로 받지 않는다", () => {
    const values = providerFormValues(row);
    expect(providerFormSchema.safeParse(values).success).toBe(false);
    expect(
      providerEditSchema({
        ...row,
        provider: { ...row.provider, base_url: "https://public.example/v1" },
      }).safeParse(values).success,
    ).toBe(false);
    expect(
      providerEditSchema(row).safeParse({ ...values, base_url: "[different placeholder]" }).success,
    ).toBe(false);
    expect(providerEditSchema(row).safeParse({ ...values, base_url: "" }).success).toBe(false);
  });
  it.each([false, true])("주소를 알 수 없어도 검토 후 활성 상태를 %s로 바꾼다", async (enabled) => {
    const user = userEvent.setup();
    const submit = vi.fn<(body: unknown) => Promise<void>>().mockResolvedValue(undefined);
    render(
      <ProviderEditDialog
        row={row}
        initialEnabled={enabled}
        onSubmit={submit}
        onOpenChange={() => undefined}
        returnFocusRef={createRef()}
      />,
    );
    expect(screen.getByLabelText(/^기본 URL/u)).toHaveValue(redactedURL);
    await user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    await screen.findByRole("table", { name: "공급자 변경 전후 비교" });
    expect(submit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "검토한 내용 저장" })).toBeDisabled();
    await acknowledge(user);
    await user.click(screen.getByRole("button", { name: "검토한 내용 저장" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0]?.[0]).toMatchObject({
      name: "public-legacy",
      base_url: redactedURL,
      enabled,
    });
  });

  it("비공개 기존 주소를 새 안전한 주소로 바꿀 수 있다", async () => {
    const user = userEvent.setup();
    const submit = vi.fn<(body: unknown) => Promise<void>>().mockResolvedValue(undefined);
    render(
      <ProviderEditDialog
        row={row}
        onSubmit={submit}
        onOpenChange={() => undefined}
        returnFocusRef={createRef()}
      />,
    );
    await user.clear(screen.getByLabelText(/^기본 URL/u));
    await user.type(screen.getByLabelText(/^기본 URL/u), "https://new.example.invalid/v1");
    await user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    await screen.findByRole("table", { name: "공급자 변경 전후 비교" });
    await acknowledge(user);
    await user.click(screen.getByRole("button", { name: "검토한 내용 저장" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ base_url: "https://new.example.invalid/v1" });
  });
});
