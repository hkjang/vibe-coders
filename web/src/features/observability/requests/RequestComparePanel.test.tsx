import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FilterSuggestions } from "@/features/observability/requests/FilterSuggestions";
import { RequestComparePanel } from "@/features/observability/requests/RequestComparePanel";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    authenticationMode: "session",
    backendVersion: "v0.84.1",
    legacyFallback: true,
    mode: "authenticated",
    user: { scopes: ["admin:read"] },
  }),
}));

const diff = {
  left: {
    request: {
      id: "req-a",
      model: "gpt-4o",
      provider: "openai",
      status_code: 200,
      latency_ms: 1200,
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      estimated_cost: 120,
      // The endpoint returns the stored prompts; the panel must not put them on screen.
      prompts: [{ role: "user", content_text: "제발 이 문장은 화면에 나오면 안 됩니다" }],
    },
    prompts: [{ role: "user", content_text: "제발 이 문장은 화면에 나오면 안 됩니다" }],
  },
  right: {
    request: {
      id: "req-b",
      model: "gpt-4o-mini",
      provider: "openai",
      status_code: 500,
      latency_ms: 300,
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      estimated_cost: 20,
    },
  },
};

describe("RequestComparePanel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("compares two requests on operational metadata and never shows prompt text", async () => {
    const api = mockApi({ "GET /admin/requests/diff": () => diff });
    const user = userEvent.setup();
    renderScreen(<RequestComparePanel requestId="req-a" />);

    // Nothing is fetched until an id is entered: the panel opens with every dialog.
    expect(api.calls).toHaveLength(0);

    await user.type(screen.getByLabelText("비교할 요청 ID"), "req-b");
    await user.click(screen.getByRole("button", { name: "비교" }));

    const table = await screen.findByRole("table", { name: "두 요청의 운영 지표 비교" });
    expect(within(table).getByText("gpt-4o-mini")).toBeVisible();
    expect(within(table).getByText("HTTP 500")).toBeVisible();
    expect(screen.queryByText(/화면에 나오면 안 됩니다/)).not.toBeInTheDocument();
    expect(api.calls[0]?.options.query).toEqual({ a: "req-a", b: "req-b" });
  });

  it("explains a failed comparison instead of showing an empty table", async () => {
    mockApi({
      "GET /admin/requests/diff": () => {
        throw apiFailure("right request not found", 404, "req_diff");
      },
    });
    const user = userEvent.setup();
    renderScreen(<RequestComparePanel requestId="req-a" />);

    await user.type(screen.getByLabelText("비교할 요청 ID"), "missing");
    await user.click(screen.getByRole("button", { name: "비교" }));

    expect(await screen.findByText("두 요청을 비교하지 못했습니다.")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});

describe("FilterSuggestions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers the values this gateway has seen for the field", async () => {
    const api = mockApi({
      "GET /admin/suggest": () => ({ field: "model", values: ["gpt-4o", "claude-sonnet-5"] }),
    });
    const { container } = renderScreen(<FilterSuggestions enabled field="model" id="models" />);

    await vi.waitFor(() => {
      expect(container.querySelectorAll("#models option")).toHaveLength(2);
    });
    expect(api.calls[0]?.options.query).toEqual({ field: "model" });
  });
});
