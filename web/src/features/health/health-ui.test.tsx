import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Activity } from "lucide-react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { exactTime, formatBytes, healthRangeLabels, isHealthRange } from "@/features/health/health-utils";
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
  it("provides Korean labels for every supported range", () => {
    expect(healthRangeLabels).toEqual({
      "1h": "1시간",
      "24h": "24시간",
      "7d": "7일",
      "30d": "30일",
    });
  });

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
    expect(screen.getByRole("alert")).toHaveTextContent("요청 ID: req-42");
    expect(screen.getByRole("alert")).toHaveTextContent("운영 위험 데이터를 확인할 수 없습니다.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("조회 실패");
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
    expect(screen.getByRole("alert")).toHaveTextContent("요청 ID: req-stale-7");
    expect(screen.getByRole("alert")).not.toHaveTextContent("갱신 실패");
    expect(screen.getByText(/마지막 정상 갱신/)).toBeVisible();
  });

  it("shows an exact timestamp while automatic refresh is paused", () => {
    usePreferences.setState({ refreshInterval: 0 });
    const timestamp = new Date("2026-09-02T09:00:00Z").getTime();
    const interval = vi.spyOn(window, "setInterval");

    try {
      render(<UpdatedTime timestamp={timestamp} />);

      expect(screen.getByText(/마지막 갱신/)).toHaveTextContent(exactTime(timestamp));
      expect(interval).not.toHaveBeenCalled();
    } finally {
      interval.mockRestore();
    }
  });

  it("updates relative time at the selected frequency and pauses while hidden", () => {
    const timestamp = new Date("2026-09-02T09:00:00Z").getTime();
    const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    let visibility: DocumentVisibilityState = "visible";
    let unmount: (() => void) | undefined;

    try {
      vi.useFakeTimers();
      vi.setSystemTime(timestamp);
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      const interval = vi.spyOn(window, "setInterval");
      const removeListener = vi.spyOn(document, "removeEventListener");
      usePreferences.setState({ refreshInterval: 60 });

      const view = render(<UpdatedTime timestamp={timestamp} />);
      unmount = view.unmount;
      expect(interval).toHaveBeenCalledWith(expect.any(Function), 60_000);
      expect(screen.getByText(/마지막 갱신/)).toHaveTextContent("지금");

      visibility = "hidden";
      act(() => vi.advanceTimersByTime(120_000));
      expect(screen.getByText(/마지막 갱신/)).toHaveTextContent("지금");

      visibility = "visible";
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(screen.getByText(/마지막 갱신/)).toHaveTextContent("2분 전");

      unmount();
      unmount = undefined;
      expect(vi.getTimerCount()).toBe(0);
      expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
    } finally {
      unmount?.();
      if (originalVisibility) {
        Object.defineProperty(document, "visibilityState", originalVisibility);
      } else {
        Reflect.deleteProperty(document, "visibilityState");
      }
      vi.restoreAllMocks();
      vi.useRealTimers();
      act(() => usePreferences.setState({ refreshInterval: 0 }));
    }
  });

  it("validates ranges and formats binary byte units", () => {
    expect(isHealthRange("30d")).toBe(true);
    expect(isHealthRange("90d")).toBe(false);
    expect(formatBytes(1_048_576)).toBe("1 MiB");
  });
});
