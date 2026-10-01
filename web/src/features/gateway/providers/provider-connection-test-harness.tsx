import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { ProviderFormDialog } from "./ProviderAdminDialogs";
import type { ProviderConnectionResult } from "@/shared/api/domains/provider-connection.schemas";
import { buildProviderRows, type ProviderCatalogRow } from "./provider-catalog";
import type { ProviderWriteBody } from "@/shared/api/domains/gateway";
import { FeatureAccessHarness } from "@/test/feature-access";

const providerRows = buildProviderRows([
  {
    name: "public-provider",
    provider_ref: `prv_${"a".repeat(43)}`,
    base_url: "https://public.example/v1",
    api_key_configured: true,
    timeout_ms: 30000,
    enabled: true,
    model_patterns: "public-*",
    failover_group: "",
    priority: 10,
    created_at: "2026-09-01T00:00:00Z",
  },
]);
const firstProvider = providerRows[0];
if (!firstProvider) throw new Error("missing public synthetic provider");
export const connectionProvider = firstProvider;
export const connectionOutcome = {
  outcome: "catalog_available",
  upstream_status: 200,
  duration_ms: 12,
  timeout_ms: 10000,
  model_count: 2,
} satisfies ProviderConnectionResult;
export const connectionEndpoint = "POST /admin/provider-connection-test";

export function connectionScreen({
  row,
  save = async () => undefined,
  credentialPrefixes,
}: {
  row?: ProviderCatalogRow;
  save?: (body: ProviderWriteBody) => Promise<unknown>;
  credentialPrefixes?: readonly string[];
} = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  function Harness() {
    const trigger = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const [readOnly, setReadOnly] = useState(false);
    return (
      <QueryClientProvider client={client}>
        <FeatureAccessHarness featureId="gateway.providers" readOnly={readOnly}>
          <button onClick={() => setReadOnly((value) => !value)}>읽기 전용 전환</button>
          <button ref={trigger} onClick={() => setOpen(true)}>
            열기
          </button>
          <ProviderFormDialog
            open={open}
            onOpenChange={setOpen}
            onSubmit={save}
            row={row}
            returnFocusRef={trigger}
            credentialPrefixes={credentialPrefixes}
          />
        </FeatureAccessHarness>
      </QueryClientProvider>
    );
  }
  render(<Harness />);
  return { client, user: userEvent.setup() };
}
export async function openConnection(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "열기" }));
  return screen.findByRole("dialog");
}
export async function fillNewConnection(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole("textbox", { name: "이름" }), "new-provider");
  await user.type(screen.getByRole("textbox", { name: "기본 URL" }), "https://public.example/v1");
}
