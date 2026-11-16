import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, expect, it, vi } from "vitest";
import type { AdminTimeseries } from "@/shared/api/schemas";
import { downloadCsv } from "@/shared/utils/csv";
import type * as Csv from "@/shared/utils/csv";
import { OverviewTrendData } from "./OverviewTrendData";

vi.mock("@/shared/utils/csv", async (original) => ({
  ...(await original<typeof Csv>()),
  downloadCsv: vi.fn(),
}));
beforeEach(() => vi.mocked(downloadCsv).mockClear());
function fixture(): AdminTimeseries {
  return {
    bucket: "hour",
    since: "2026-11-16T16:15:00Z",
    points: [
      { date: "2026-11-17T01", bucket: "hour", requests: 2, tokens: 12, cost_krw: 0.0004 },
      { date: "2026-11-17T02", bucket: "hour", requests: 10, tokens: 7, cost_krw: 0.0012 },
    ],
  };
}
function view(data = fixture(), isDataCurrent = () => true) {
  return render(
    <OverviewTrendData data={data} label="최근 1시간" range="1h" isDataCurrent={isDataCurrent} />,
  );
}

it("집계 단위·한국 시간·부분 구간과 수신 합계를 구분한다", () => {
  view();
  expect(screen.getByText(/한국 시간 \(KST\) · 1시간 단위/)).toBeInTheDocument();
  expect(screen.getByText(/기록이 없는 구간은 생략/)).toBeInTheDocument();
  expect(screen.getByText("12건")).toBeInTheDocument();
  expect(screen.getByText("19개")).toBeInTheDocument();
  expect(screen.getByRole("table", { name: "최근 1시간 구간별 요청·토큰·비용" })).toBeInTheDocument();
  for (const chart of screen.getAllByRole("img")) {
    expect(chart.getAttribute("aria-describedby")).toBe(
      screen.getByRole("heading", { name: "구간별 요청·토큰·비용" }).id,
    );
  }
});

it("표의 수치 정렬과 CSV 순서가 같으며 ISO 시각과 원래 비용을 보존한다", async () => {
  view();
  await userEvent.click(screen.getByRole("button", { name: "비용 내림차순 정렬" }));
  const rows = within(screen.getByRole("table")).getAllByRole("row");
  expect(rows[1]).toHaveTextContent("2026-11-17 02시");
  expect(rows[2]).toHaveTextContent("2026-11-17 01시");
  await userEvent.click(screen.getByRole("button", { name: "구간 CSV 내려받기" }));
  expect(downloadCsv).toHaveBeenCalledTimes(1);
  const csv = vi.mocked(downloadCsv).mock.calls[0]?.[1] ?? "";
  expect(csv).toContain("2026-11-16T17:00:00.000Z,시간,10,7,0.0012");
  expect(csv.indexOf("17:00:00")).toBeLessThan(csv.indexOf("16:00:00"));
});

it("조회 소유권이 바뀐 뒤 CSV를 만들지 않는다", async () => {
  let current = true;
  view(fixture(), () => current);
  current = false;
  await userEvent.click(screen.getByRole("button", { name: "구간 CSV 내려받기" }));
  expect(downloadCsv).not.toHaveBeenCalled();
});

it("빈 응답의 CSV를 막고 조회 기간 변경을 안내한다", () => {
  view({ ...fixture(), points: [] });
  expect(screen.getByRole("button", { name: "구간 CSV 내려받기" })).toBeDisabled();
  expect(screen.getByText(/이 기간에 기록된 구간이 없습니다/)).toBeInTheDocument();
});

it("비정상 구간 원문을 숨기고 키보드 표와 차트의 접근성을 유지한다", async () => {
  const data = fixture();
  data.points = [
    { date: "=private_value", bucket: "unknown-private", requests: 1, tokens: 1, cost_krw: 0.0004 },
  ];
  const { container } = view(data);
  expect(container.innerHTML).not.toContain("private");
  await userEvent.click(screen.getByRole("button", { name: "구간 CSV 내려받기" }));
  expect(vi.mocked(downloadCsv).mock.calls[0]?.[1]).not.toContain("private");
  expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual(
    [],
  );
});
