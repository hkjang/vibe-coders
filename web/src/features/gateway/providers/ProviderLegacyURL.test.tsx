import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";

import { ProviderEditDialog } from "@/features/gateway/providers/ProviderEditDialog";
import { buildProviderRows } from "@/features/gateway/providers/provider-catalog";
import {
  providerEditSchema,
  providerFormSchema,
  providerFormValues,
} from "@/features/gateway/providers/provider-form";

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
    await user.click(screen.getByRole("button", { name: "검토한 내용 저장" }));
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ base_url: "https://new.example.invalid/v1" });
  });
});
