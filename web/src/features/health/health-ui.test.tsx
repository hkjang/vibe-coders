import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activity } from "lucide-react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { exactTime, formatBytes, isHealthRange } from "@/features/health/health-utils";
import { HealthWidget, TimeRangePicker, UpdatedTime } from "@/features/health/health-ui";
import { useHealthRange } from "@/features/health/use-health-range";
import { AppError } from "@/shared/api/error";
import { usePreferences } from "@/shared/stores/preferences";

function RangeHarness(): React.JSX.Element {
  const [range, setRange] = useHealthRange();
  const location = useLocation();
  return (
    <>
      <TimeRangePicker value={range} onChange={setRange} />
      <output>{location.search}</output>
    </>
  );
}

describe("health UI primitives", () => {
  it("stores the selected range in the URL while preserving other filters", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/health?team=platform&range=invalid"]}>
        <Routes>
          <Route path="health" element={<RangeHarness />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByRole("button", { name: "24시간" })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(screen.getByText(/team=platform/)).toHaveTextContent("range=24h"));
    await user.click(screen.getByRole("button", { name: "7일" }));
    expect(screen.getByText(/team=platform/)).toHaveTextContent("range=7d");
  });

  it("renders a retryable partial failure with its request ID", async () => {
    const retry = vi.fn();
    const user = userEvent.setup();
    render(
      <HealthWidget
        title="운영 위험"
        icon={Activity}
        error={new AppError("조회 실패", { kind: "http", requestId: "req-42" })}
        onRetry={retry}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Request ID: req-42");
    await user.click(screen.getByRole("button", { name: "운영 위험 재시도" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps the last successful content visible when a refresh fails", () => {
    render(
      <HealthWidget
        title="Provider 상태"
        icon={Activity}
        error={new AppError("갱신 실패", { kind: "http", requestId: "req-stale-7" })}
        updatedAt={Date.now() - 60_000}
      >
        <p>마지막 정상 Provider 3개</p>
      </HealthWidget>,
    );

    expect(screen.getByText("마지막 정상 Provider 3개")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("마지막 정상 데이터를 표시합니다");
    expect(screen.getByRole("alert")).toHaveTextContent("Request ID: req-stale-7");
    expect(screen.getByText(/마지막 정상 갱신/)).toBeVisible();
  });

  it("shows an exact timestamp while automatic refresh is paused", () => {
    usePreferences.setState({ refreshInterval: 0 });
    const timestamp = new Date("2026-09-02T09:00:00Z").getTime();

    render(<UpdatedTime timestamp={timestamp} />);

    expect(screen.getByText(/마지막 갱신/)).toHaveTextContent(exactTime(timestamp));
  });

  it("uses relative time only when the user enables automatic refresh", () => {
    usePreferences.setState({ refreshInterval: 60 });
    const timestamp = new Date("2026-09-02T09:00:00Z").getTime();
    const now = vi.spyOn(Date, "now").mockReturnValue(timestamp + 120_000);

    try {
      render(<UpdatedTime timestamp={timestamp} />);
      expect(screen.getByText(/마지막 갱신/)).toHaveTextContent("2분 전");
    } finally {
      now.mockRestore();
      act(() => usePreferences.setState({ refreshInterval: 0 }));
    }
  });

  it("validates ranges and formats binary byte units", () => {
    expect(isHealthRange("30d")).toBe(true);
    expect(isHealthRange("90d")).toBe(false);
    expect(formatBytes(1_048_576)).toBe("1 MiB");
  });
});
