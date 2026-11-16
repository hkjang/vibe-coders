import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import type { AdminStats } from "@/shared/api/schemas";
import { OverviewUsageTab } from "./OverviewUsageTab";

function fixture(): AdminStats {
  return {
    total_requests: 100,
    total_tokens: 1000,
    total_cost_krw: 150,
    average_latency_ms: 20,
    by_status: [
      { class: "2xx", requests: 8 },
      { class: "5xx", requests: 2 },
    ],
    by_model: [
      { key: "모델 2", requests: 2, tokens: 10, cost_krw: 100, average_latency_ms: 2 },
      { key: "모델 10", requests: 10, tokens: 2, cost_krw: 9, average_latency_ms: 10 },
    ],
    by_ip: [{ key: "192.0.2.1", requests: 3, tokens: 20, cost_krw: 5, average_latency_ms: 10 }],
    by_language: [
      { language: "TypeScript", requests: 9, average_confidence: 0.9 },
      { language: "Go", requests: 3, average_confidence: 0.99 },
    ],
    top_users: [
      {
        api_key_id: "key-id",
        name: "연구용 키",
        team: "연구팀",
        owner: "hidden-owner",
        status: "active",
        requests: 3,
        tokens: 100,
        cost_krw: 5,
        average_latency_ms: 2,
        last_seen: "2026-11-01T00:00:00Z",
      },
    ],
    latency_quantiles: { p50: 1, p95: 2, p99: 3 },
    first_chunk_quantiles: { p50: 1, p95: 2, p99: 3 },
    cache: { entries: 0, bytes: 0, total_hits: 0, top_models: [] },
    failover_total: 0,
    cache_hits: 0,
    cache_misses: 0,
  };
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("필수 테스트 데이터가 없습니다.");
  return value;
}
const section = (name: string) => within(screen.getByRole("region", { name }));
const firstCell = (name: string) =>
  required(within(required(section(name).getAllByRole("row")[1])).getAllByRole("cell")[0]);

describe("운영 개요의 수신 사용량 탐색", () => {
  it("API 키 기준과 상위 항목·보존 기간·분모 제한을 안내한다", () => {
    render(<OverviewUsageTab stats={fixture()} />);
    expect(screen.getByRole("heading", { name: "요청량 상위 API 키" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "상위 사용자" })).not.toBeInTheDocument();
    expect(screen.getByText(/위 추이 그래프의 기간 선택은 적용되지 않습니다/)).toBeInTheDocument();
    expect(screen.getByText(/최대 5개/)).toBeInTheDocument();
    expect(screen.getAllByText(/최대 50개/)).toHaveLength(2);
    expect(screen.getByText(/한 요청에서 여러 언어/)).toBeInTheDocument();
    expect(section("상태 분포").getByText("80.0%", { exact: true })).toBeInTheDocument();
  });

  it("표마다 한글 검색과 표시 수를 독립 적용하고 지우기 후 입력으로 돌아간다", async () => {
    const user = userEvent.setup();
    render(<OverviewUsageTab stats={fixture()} />);
    const model = section("모델별 사용량");
    await user.type(model.getByRole("searchbox"), "모델 2");
    expect(model.getByText("수신 2개 중 1개 표시")).toBeInTheDocument();
    expect(model.queryByText("모델 10")).not.toBeInTheDocument();
    expect(section("언어별 사용량").getByText("수신 2개 중 2개 표시")).toBeInTheDocument();
    await user.click(model.getByRole("button", { name: "검색 지우기" }));
    expect(model.getByRole("searchbox")).toHaveFocus();
    expect(model.getByText("모델 10")).toBeInTheDocument();
  });

  it("요청·비용·지연은 문자열 대신 수치로 정렬하고 정렬 방향을 알린다", async () => {
    const user = userEvent.setup();
    const data = fixture();
    render(<OverviewUsageTab stats={data} />);
    const model = section("모델별 사용량");
    expect(firstCell("모델별 사용량")).toHaveTextContent("모델 10");
    await user.click(model.getByRole("button", { name: "요청 수 오름차순 정렬" }));
    expect(firstCell("모델별 사용량")).toHaveTextContent("모델 2");
    expect(model.getByRole("columnheader", { name: /요청 수/ })).toHaveAttribute("aria-sort", "ascending");
    await user.click(model.getByRole("button", { name: "비용 (원) 내림차순 정렬" }));
    expect(firstCell("모델별 사용량")).toHaveTextContent("모델 2");
    await user.click(model.getByRole("button", { name: "평균 지연 (ms) 내림차순 정렬" }));
    expect(firstCell("모델별 사용량")).toHaveTextContent("모델 10");
    expect(data.by_model.map((row) => row.key)).toEqual(["모델 2", "모델 10"]);
  });

  it("상태 검색이 비중의 분모나 다른 표의 집계를 바꾸지 않는다", async () => {
    const user = userEvent.setup();
    render(<OverviewUsageTab stats={fixture()} />);
    const status = section("상태 분포");
    await user.type(status.getByRole("searchbox"), "서버 오류");
    expect(status.getByText("20.0%", { exact: true })).toBeInTheDocument();
    expect(status.queryByText("100.0%", { exact: true })).not.toBeInTheDocument();
    expect(status.getByText("수신 2개 중 1개 표시")).toBeInTheDocument();
  });

  it("표시된 키 이름과 팀만 검색하고 숨겨진 소유자로 검색하지 않는다", async () => {
    const user = userEvent.setup();
    render(<OverviewUsageTab stats={fixture()} />);
    const keys = section("요청량 상위 API 키");
    await user.type(keys.getByRole("searchbox"), "연구팀");
    expect(keys.getByText("연구용 키")).toBeInTheDocument();
    await user.clear(keys.getByRole("searchbox"));
    await user.type(keys.getByRole("searchbox"), "hidden-owner");
    expect(keys.queryByText("연구용 키")).not.toBeInTheDocument();
    expect(keys.getByText(/검색과 일치하는 항목이 없습니다/)).toBeInTheDocument();
  });

  it("영문 대소문자·전각 입력을 정규화하고 신뢰도를 수치로 정렬한다", async () => {
    const user = userEvent.setup();
    render(<OverviewUsageTab stats={fixture()} />);
    const languages = section("언어별 사용량");
    await user.type(languages.getByRole("searchbox"), "  ＴＹＰＥ  ");
    expect(languages.getByText("TypeScript")).toBeInTheDocument();
    expect(languages.queryByText("Go", { exact: true })).not.toBeInTheDocument();
    await user.click(languages.getByRole("button", { name: "검색 지우기" }));
    await user.click(languages.getByRole("button", { name: "평균 신뢰도 내림차순 정렬" }));
    expect(firstCell("언어별 사용량")).toHaveTextContent("Go");
  });

  it("수신 데이터가 바뀌면 이전 행을 남기지 않고 검색을 새 데이터에 적용한다", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<OverviewUsageTab stats={fixture()} />);
    await user.type(section("모델별 사용량").getByRole("searchbox"), "모델 2");
    const next = fixture();
    next.by_model = [{ ...required(next.by_model[0]), key: "다른 모델" }];
    rerender(<OverviewUsageTab stats={next} />);
    expect(section("모델별 사용량").getByText("수신 1개 중 0개 표시")).toBeInTheDocument();
    expect(screen.queryByText("모델 2")).not.toBeInTheDocument();
    rerender(<OverviewUsageTab stats={undefined} />);
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    rerender(<OverviewUsageTab stats={fixture()} />);
    expect(section("모델별 사용량").getByRole("searchbox")).toHaveValue("");
  });

  it("실제 빈 집계에는 검색 없음 안내 대신 기록이 생기는 조건을 표시한다", () => {
    const data = fixture();
    data.by_model = [];
    render(<OverviewUsageTab stats={data} />);
    expect(section("모델별 사용량").getByText("모델 사용 기록이 없습니다.")).toBeInTheDocument();
    expect(section("모델별 사용량").queryByRole("searchbox")).not.toBeInTheDocument();
  });

  it("서버 문자열을 HTML로 해석하지 않고 표·입력·정렬의 접근성을 유지한다", async () => {
    const data = fixture();
    required(data.by_model[0]).key = '<img src=x onerror="alert(1)">';
    const { container } = render(<OverviewUsageTab stats={data} />);
    expect(screen.getByText(required(data.by_model[0]).key)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(
      (await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations,
    ).toEqual([]);
  });
});
