import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import { downloadCsv } from "@/shared/utils/csv";
import type * as Csv from "@/shared/utils/csv";
import {
  capturedClicks,
  deferred,
  list,
  row,
  renderRequests,
  runtime,
} from "./request-safe-flow-test-harness";

vi.mock("@/shared/utils/csv", async (original) => ({
  ...(await original<typeof Csv>()),
  downloadCsv: vi.fn(),
}));
beforeEach(() => vi.mocked(downloadCsv).mockClear());

it.each([401, 403])("목록이 %s로 거부되면 이전 CSV 동작과 행을 폐기한다", async (status) => {
  const view = renderRequests();
  await screen.findByRole("button", { name: /1번째 요청.*상세 보기/u });
  const exportBeforeDenial = capturedClicks.get("현재 목록 CSV");
  const refreshBeforeDenial = capturedClicks.get("새로고침");
  const oldQuery = view.client
    .getQueryCache()
    .findAll()
    .find((query) => query.queryKey.includes("request-list-read"));
  expect(exportBeforeDenial).toBeTypeOf("function");
  expect(refreshBeforeDenial).toBeTypeOf("function");
  expect(oldQuery).toBeDefined();
  view.replyList(async () => {
    throw new AppError("synthetic denial", { kind: "permission", status });
  });
  await act(async () => {
    await view.refresh();
  });
  act(() => exportBeforeDenial?.());
  expect(downloadCsv).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /1번째 요청.*상세 보기/u })).not.toBeInTheDocument(),
  );
  expect(screen.getByRole("heading")).toHaveFocus();
  const entries = view.client
    .getQueryCache()
    .findAll()
    .filter((query) => query.queryKey.includes("request-list-read"));
  // A disabled observer may recreate an empty Query; the old Query and its data must be gone.
  expect(entries).not.toContain(oldQuery);
  expect(entries.every((query) => query.state.data === undefined)).toBe(true);
  view.replyList(async () => structuredClone(list));
  const attempts = view.listCalls().length;
  await act(async () => refreshBeforeDenial?.());
  expect(view.listCalls()).toHaveLength(attempts);
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await screen.findByRole("button", { name: /1번째 요청.*상세 보기/u });
  act(() => exportBeforeDenial?.());
  expect(downloadCsv).not.toHaveBeenCalled();
  const recoveredAttempts = view.listCalls().length;
  await act(async () => refreshBeforeDenial?.());
  expect(view.listCalls()).toHaveLength(recoveredAttempts);
  await userEvent.click(screen.getByRole("button", { name: "현재 목록 CSV" }));
  expect(downloadCsv).toHaveBeenCalledTimes(1);
});

const batch = {
  ...list,
  requests: [1, 2, 3].map((index) => ({
    ...row,
    request_id: `request-${index}`,
    request_ref: `req_${"a".repeat(22)}.${String(index).repeat(21)}`,
    model: index === 3 ? "=1+1" : `model-${index}`,
    estimated_cost: index * 0.0004,
  })),
};
async function start() {
  const view = renderRequests({ initialList: async () => structuredClone(batch) });
  await screen.findByRole("button", { name: /1번째 요청.*상세 보기/u });
  await userEvent.click(screen.getByRole("button", { name: "여러 요청 선택" }));
  return view;
}
const rowCheckbox = (ordinal: number) => screen.getByRole("checkbox", { name: `${ordinal}번째 요청 선택` });

it("현재 페이지에서 선택한 행만 원래 순서·비용으로 내보내며 수식 입력을 이스케이프한다", async () => {
  const view = await start();
  await userEvent.click(rowCheckbox(3));
  await userEvent.click(rowCheckbox(1));
  expect(screen.getByRole("checkbox", { name: "현재 페이지 요청 전체 선택" })).toBePartiallyChecked();
  expect(screen.getByText(/3건 중 2건 선택/u)).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "선택한 요청 CSV" }));
  expect(downloadCsv).toHaveBeenCalledTimes(1);
  const [name, csv] = vi.mocked(downloadCsv).mock.calls[0] ?? [];
  expect(name).toMatch(/^requests-selected-/u);
  expect(csv).toContain("request-1");
  expect(csv).toContain("request-3");
  expect(csv).not.toContain("request-2");
  expect(csv?.indexOf("request-1")).toBeLessThan(csv?.indexOf("request-3") ?? 0);
  expect(csv).toContain("0.0004");
  expect(csv).toContain("'=1+1");
  expect(view.listCalls()).toHaveLength(1);
  expect((await axe.run(screen.getByRole("table", { name: "현재 페이지 요청 목록" }))).violations).toEqual(
    [],
  );
});

it("선택 해제·재선택 뒤 이전 내보내기 동작을 재사용하지 않는다", async () => {
  await start();
  const all = screen.getByRole("checkbox", { name: "현재 페이지 요청 전체 선택" });
  all.focus();
  await userEvent.keyboard(" ");
  expect(all).toBeChecked();
  const old = capturedClicks.get("선택한 요청 CSV");
  await userEvent.click(screen.getByRole("button", { name: "선택 해제" }));
  expect(all).not.toBeChecked();
  await userEvent.click(all);
  act(() => old?.());
  expect(downloadCsv).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "선택한 요청 CSV" }));
  expect(downloadCsv).toHaveBeenCalledTimes(1);
});

it("내용과 시각이 같은 새 응답도 선택과 이전 목록 CSV를 폐기한다", async () => {
  const view = await start();
  await userEvent.click(rowCheckbox(1));
  const selected = capturedClicks.get("선택한 요청 CSV");
  const all = capturedClicks.get("현재 목록 CSV");
  await act(async () => {
    await view.refresh();
  });
  await waitFor(() => expect(rowCheckbox(1)).not.toBeChecked());
  act(() => {
    selected?.();
    all?.();
  });
  expect(downloadCsv).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "선택한 요청 CSV" })).toBeDisabled();
});

it("다른 필터를 기다리는 동안 이전 행의 선택·CSV를 막고 복귀해도 선택을 되살리지 않는다", async () => {
  const view = await start();
  await userEvent.click(rowCheckbox(1));
  const selected = capturedClicks.get("선택한 요청 CSV");
  const pending = deferred<typeof batch>();
  view.replyList(() => pending.promise);
  act(() => view.navigate("?model=another"));
  await screen.findByText("새 필터를 조회하는 동안 직전 결과를 표시합니다.");
  expect(rowCheckbox(1)).toBeDisabled();
  expect(rowCheckbox(1)).not.toBeChecked();
  expect(screen.getByRole("button", { name: "현재 목록 CSV" })).toBeDisabled();
  act(() => selected?.());
  expect(downloadCsv).not.toHaveBeenCalled();
  await act(async () => pending.resolve(structuredClone(batch)));
  await waitFor(() => expect(rowCheckbox(1)).not.toBeDisabled());
  view.replyList(async () => structuredClone(batch));
  act(() => view.navigate(""));
  await waitFor(() => expect(rowCheckbox(1)).not.toBeDisabled());
  expect(rowCheckbox(1)).not.toBeChecked();
  act(() => selected?.());
  expect(downloadCsv).not.toHaveBeenCalled();
});

it("일시 오류는 마지막 행을 유지하되 내보내기를 막고 새 조회 후 빈 선택으로 복구한다", async () => {
  const view = await start();
  await userEvent.click(rowCheckbox(2));
  const old = capturedClicks.get("선택한 요청 CSV");
  view.replyList(async () => {
    throw new AppError("synthetic unavailable", { kind: "http", status: 503 });
  });
  await act(async () => {
    await view.refresh();
  });
  await screen.findByText("갱신에 실패해 마지막 정상 데이터를 표시합니다.");
  expect(rowCheckbox(2)).toBeDisabled();
  act(() => old?.());
  expect(downloadCsv).not.toHaveBeenCalled();
  view.replyList(async () => structuredClone(batch));
  await userEvent.click(screen.getByRole("button", { name: "재시도" }));
  await waitFor(() => expect(rowCheckbox(2)).not.toBeDisabled());
  expect(rowCheckbox(2)).not.toBeChecked();
});

it("계정 변경·화면 종료 후 선택 내보내기를 실행하지 않는다", async () => {
  const view = await start();
  await userEvent.click(rowCheckbox(1));
  const old = capturedClicks.get("선택한 요청 CSV");
  runtime.id = "another-reader";
  view.rerenderRuntime();
  act(() => old?.());
  expect(downloadCsv).not.toHaveBeenCalled();
  view.unmount();
  act(() => old?.());
  expect(downloadCsv).not.toHaveBeenCalled();
});

it("조회 캐시를 같은 데이터로 다시 만들어도 이전 선택 내보내기가 되살아나지 않는다", async () => {
  const view = await start();
  await userEvent.click(rowCheckbox(1));
  const old = capturedClicks.get("선택한 요청 CSV");
  const entry = view.client
    .getQueryCache()
    .findAll()
    .find((query) => query.queryKey.includes("request-list-read"));
  expect(entry).toBeDefined();
  if (!entry) return;
  const data = entry.state.data;
  act(() => {
    view.client.removeQueries({ queryKey: entry.queryKey, exact: true });
    view.client.setQueryData(entry.queryKey, data);
    old?.();
  });
  expect(downloadCsv).not.toHaveBeenCalled();
});
