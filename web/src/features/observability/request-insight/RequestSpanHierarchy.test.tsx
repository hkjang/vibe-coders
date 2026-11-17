import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  flowCard,
  rootName,
  rootSpan,
  setupFlow,
  toolName,
  toolSpan,
  traceFixture,
  traceKey,
} from "./request-flow-test-harness";

describe("request span record relationships", () => {
  it("switches the existing records without fetching again and keeps every record visible", async () => {
    const flow = setupFlow();
    await screen.findByText(toolName, { selector: "code" });
    await flow.user.click(screen.getByRole("button", { name: "기록 관계" }));
    const roots = within(flowCard()).getByRole("list", { name: "요청 기록 관계" });
    expect(within(roots).getByText(rootName, { selector: "code" })).toBeVisible();
    expect(within(roots).getByText(toolName, { selector: "code" })).toBeVisible();
    expect(within(roots).getByText("하위 기록 1개")).toBeVisible();
    expect(flow.attempts).toHaveLength(2);
    await flow.user.click(screen.getByRole("button", { name: "흐름 막대" }));
    expect(screen.getByRole("list", { name: "요청 스팬 흐름" })).toBeVisible();
    expect(flow.attempts).toHaveLength(2);
  });

  it("keeps the relationship control focused during refresh and preserves its disclosure", async () => {
    const flow = setupFlow();
    await screen.findByText(toolName, { selector: "code" });
    await flow.user.click(screen.getByRole("button", { name: "기록 관계" }));
    const summary = screen.getByText("하위 기록 1개");
    await flow.user.click(summary);
    expect(summary.parentElement).not.toHaveAttribute("open");
    summary.focus();
    await act(async () => flow.client.refetchQueries({ queryKey: traceKey() }));
    expect(summary).toHaveFocus();
    expect(summary.parentElement).not.toHaveAttribute("open");
    expect(screen.getByText(toolName, { selector: "code" })).not.toBeVisible();
  });

  it("shows independent records for missing/cyclic identities and preserves secret display protection", async () => {
    const secret = "vc_sk_relation-secret-example";
    const flow = setupFlow({
      trace: () =>
        traceFixture({
          spans: [
            rootSpan(),
            toolSpan({ span_id: "a", parent_span_id: "b", name: "순환 하나" }),
            toolSpan({ span_id: "b", parent_span_id: "a", name: "순환 둘" }),
            toolSpan({ span_id: secret, parent_span_id: "missing", name: secret, error: secret }),
          ],
        }),
    });
    await screen.findByText(rootName, { selector: "code" });
    await flow.user.click(screen.getByRole("button", { name: "기록 관계" }));
    const tree = screen.getByRole("list", { name: "요청 기록 관계" });
    expect(within(tree).getAllByRole("listitem")).toHaveLength(4);
    expect(within(tree).getAllByText(/순환 관계/u)).toHaveLength(2);
    expect(tree).not.toHaveTextContent(secret);
    expect(tree.outerHTML).not.toContain(secret);
    expect(flow.attempts).toHaveLength(2);
  });
});
