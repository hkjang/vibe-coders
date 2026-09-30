import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderChangeReview } from "@/features/gateway/providers/ProviderChangeReview";
import { buildProviderRows } from "@/features/gateway/providers/provider-catalog";
import type { ProviderWriteBody } from "@/shared/api/domains/gateway";
import type { Provider } from "@/shared/api/schemas";

const provider = {
  name: "review-provider",
  provider_ref: `prv_${"a".repeat(43)}`,
  base_url: "https://review.example/v1",
  api_key_configured: true,
  timeout_ms: 30_000,
  enabled: true,
  model_patterns: "review-*",
  failover_group: "review-group",
  priority: 10,
  created_at: "2026-09-01T00:00:00Z",
} satisfies Provider;

function reviewedCell(label: string): HTMLElement {
  const row = screen.getByRole("row", { name: new RegExp(label) });
  const cell = within(row).getAllByRole("cell")[1];
  if (!cell) throw new Error("missing reviewed value");
  return cell;
}

describe("공급자 숫자 설정의 서버 적용 의미", () => {
  // handleProviders preserves an omitted priority, defaults an explicit zero,
  // and defaults any non-positive timeout. Do not guess runtime default values.
  it.each([
    {
      title: "미입력",
      priority: undefined,
      timeout: undefined,
      priorityDescription: "저장된 값 유지 (없으면 서버 기본값)",
      timeoutDescription: "서버 기본 제한 시간",
    },
    {
      title: "명시적 0",
      priority: 0,
      timeout: 0,
      priorityDescription: "서버 기본 우선순위",
      timeoutDescription: "서버 기본 제한 시간",
    },
    {
      title: "양의 정수",
      priority: 25,
      timeout: 45_000,
      priorityDescription: "25",
      timeoutDescription: "45000",
    },
  ])("$title 값을 실제 적용 규칙대로 설명하고 전송 객체는 바꾸지 않는다", (example) => {
    const row = buildProviderRows([provider])[0];
    if (!row) throw new Error("missing public provider row");
    const body = Object.freeze({
      name: provider.name,
      base_url: provider.base_url,
      priority: example.priority,
      timeout_ms: example.timeout,
      enabled: true,
    } satisfies ProviderWriteBody);
    render(<ProviderChangeReview row={row} body={body} />);

    expect(reviewedCell("우선순위").textContent).toBe(example.priorityDescription);
    expect(reviewedCell("제한 시간").textContent).toBe(example.timeoutDescription);
    expect(body.priority).toBe(example.priority);
    expect(body.timeout_ms).toBe(example.timeout);
    expect(screen.getByText(/다른 관리자의 동시 변경을 막지는 않습니다/)).toBeInTheDocument();
  });
});
