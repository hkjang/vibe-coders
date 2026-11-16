import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { validateRequestTimeFilters } from "@/shared/utils/request-time-filters";
import { RequestFilters } from "./RequestFilters";
import { requestPresetRange, requestTimePresets } from "./request-time-presets";

vi.mock("./FilterSuggestions", () => ({ FilterSuggestions: () => null }));
afterEach(() => vi.restoreAllMocks());

it.each([
  [0, "2026-03-08T09:30:00.123Z"],
  [1, "2026-03-07T10:30:00.123Z"],
  [2, "2026-03-01T10:30:00.123Z"],
  [3, "2026-02-06T10:30:00.123Z"],
] as const)("기간 %i는 날짜·서머타임 경계에서도 절대 시각으로 입력한다", (index, from) => {
  const range = requestPresetRange(requestTimePresets[index], Date.parse("2026-03-08T10:30:00.123Z"));
  expect(range).toEqual({ from, to: "2026-03-08T10:30:00.123Z" });
  for (const tz of ["UTC", "Asia/Seoul", "America/Los_Angeles"])
    expect(validateRequestTimeFilters({ ...range, tz })).toBeUndefined();
});

function start() {
  const submit = vi.fn();
  const input = vi.fn();
  render(
    <RequestFilters
      query={{ from: "2026-02-01", to: "2026-02-02", tz: "Asia/Seoul", limit: 25 }}
      searchParams={new URLSearchParams({ model: "기존 모델" })}
      onSubmit={(event) => {
        event.preventDefault();
        submit(Object.fromEntries(new FormData(event.currentTarget)));
      }}
      onInput={input}
      onReset={vi.fn()}
    />,
  );
  return { submit, input };
}

it("기간 선택은 다른 입력 초안을 보존하며 조회를 눌러야 제출한다", async () => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-17T00:30:00Z"));
  const { submit, input } = start();
  const user = userEvent.setup();
  await user.clear(screen.getByLabelText("모델", { exact: true }));
  await user.type(screen.getByLabelText("모델", { exact: true }), "입력 중인 모델");
  await user.click(screen.getByRole("button", { name: "최근 24시간" }));
  expect(screen.getByLabelText("시작 시각")).toHaveValue("2026-11-16T00:30:00.000Z");
  expect(screen.getByLabelText("종료 시각")).toHaveValue("2026-11-17T00:30:00.000Z");
  expect(screen.getByRole("status")).toHaveTextContent("조회를 누르면 적용합니다");
  expect(input).toHaveBeenCalled();
  expect(submit).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "조회" }));
  expect(submit).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      from: "2026-11-16T00:30:00.000Z",
      to: "2026-11-17T00:30:00.000Z",
      model: "입력 중인 모델",
      tz: "Asia/Seoul",
      limit: "25",
    }),
  );
});

it("직접 시각을 고치면 빠른 입력 안내를 지우고 다음 선택은 새 시각을 사용한다", async () => {
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-17T00:30:00Z"));
  start();
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "최근 1시간" }));
  await user.clear(screen.getByLabelText("시작 시각"));
  await user.type(screen.getByLabelText("시작 시각"), "2026-11-15");
  expect(screen.getByRole("status", { hidden: true })).toBeEmptyDOMElement();
  clock.mockReturnValue(Date.parse("2026-11-17T01:30:00Z"));
  await user.click(screen.getByRole("button", { name: "최근 1시간" }));
  expect(screen.getByLabelText("시작 시각")).toHaveValue("2026-11-17T00:30:00.000Z");
  expect(screen.getByLabelText("종료 시각")).toHaveValue("2026-11-17T01:30:00.000Z");
});
