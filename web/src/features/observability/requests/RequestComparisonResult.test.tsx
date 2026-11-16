import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RequestComparisonResult } from "./RequestComparisonResult";
import { comparisonRequest as request } from "./request-comparison-fixtures";

describe("comparison result presentation", () => {
  it("keeps incomparable currencies visible while hiding equal fields", async () => {
    const left = { ...request("same"), currency: "USD", estimated_cost: 0.000123 };
    const right = { ...left, currency: "KRW" };
    render(<RequestComparisonResult left={left} right={right} prefixes={[]} />);
    expect(screen.getByRole("status", { name: "요청 비교 요약" })).toHaveTextContent(
      "다른 항목 0개 · 비교 제외 1개",
    );
    await userEvent.click(screen.getByRole("checkbox", { name: "같은 항목 숨기기" }));
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("통화가 달라 비교 제외")).toBeVisible();
    expect(within(table).getByText("0.000123 USD")).toHaveAttribute("title", "0.000123 USD");
    expect(within(table).getByText("0.000123 KRW")).toBeVisible();
  });
  it("shows an explicit empty result for a self-comparison and restores every row", async () => {
    const row = request("same");
    render(<RequestComparisonResult left={row} right={row} prefixes={[]} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "같은 항목 숨기기" }));
    expect(screen.getByText(/모든 비교 가능한 항목이 같습니다/)).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("checkbox", { name: "같은 항목 숨기기" }));
    expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(13);
  });
});
