import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import { dataTablePreferenceStorageKey } from "@/shared/data-table/table-preferences";
import { downloadCsv } from "@/shared/utils/csv";
import type * as Csv from "@/shared/utils/csv";
import { list, renderRequests, row } from "./request-safe-flow-test-harness";
import { requestTableId } from "./request-table-columns";

vi.mock("@/shared/utils/csv", async (original) => ({
  ...(await original<typeof Csv>()),
  downloadCsv: vi.fn(),
}));
const key = dataTablePreferenceStorageKey(requestTableId);
const headers = () =>
  within(screen.getByRole("table"))
    .getAllByRole("columnheader")
    .map((cell) => cell.textContent);
async function openSettings() {
  await userEvent.click(screen.getByRole("button", { name: "열 설정" }));
  return screen.findByRole("dialog", { name: "표 열 설정" });
}
async function start() {
  const view = renderRequests();
  await screen.findByRole("button", { name: /1번째 요청.*상세 보기/u });
  return view;
}

it("열을 숨기고 다시 열어도 유지하며 시각·요청 ID는 항상 표시한다", async () => {
  const view = await start();
  const dialog = await openSettings();
  expect(within(dialog).getByRole("checkbox", { name: /^시각/u })).toBeDisabled();
  expect(within(dialog).getByRole("checkbox", { name: /^요청 ID/u })).toBeDisabled();
  expect(dialog).toHaveTextContent("CSV는 전체 운영 항목을 포함합니다.");
  await userEvent.click(within(dialog).getByRole("checkbox", { name: /^모델/u }));
  expect((await axe.run(dialog)).violations).toEqual([]);
  await userEvent.click(within(dialog).getByRole("button", { name: "설정 완료" }));
  expect(screen.getByRole("button", { name: "열 설정" })).toHaveFocus();
  expect(headers()).not.toContain("모델");
  view.unmount();
  await start();
  await waitFor(() => expect(headers()).not.toContain("모델"));
  expect(headers()).toContain("시각");
  expect(headers()).toContain("요청 ID");
});

it("열 순서와 키보드 너비를 저장하되 행·조회 정보는 저장하거나 다시 읽지 않는다", async () => {
  const view = await start();
  const dialog = await openSettings();
  await userEvent.click(within(dialog).getByRole("button", { name: "공급자 열을 왼쪽으로 이동" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "설정 완료" }));
  expect(headers().indexOf("공급자")).toBeLessThan(headers().indexOf("모델"));
  const resize = screen.getByRole("separator", { name: "모델 열 너비 조절" });
  resize.focus();
  await userEvent.keyboard("{End}");
  expect(resize).toHaveAttribute("aria-valuenow", "640");
  await userEvent.keyboard("{Home}{ArrowRight}");
  expect(resize).toHaveAttribute("aria-valuenow", "96");
  const stored = localStorage.getItem(key) ?? "";
  expect(stored).not.toContain(row.request_ref);
  expect(stored).not.toContain(row.model);
  expect(stored).not.toContain(row.created_at);
  expect(stored).not.toContain("cursor");
  const preferences = JSON.parse(stored) as Record<string, unknown>;
  expect(Object.keys(preferences).sort()).toEqual([
    "columnOrder",
    "columnSizing",
    "columnVisibility",
    "version",
  ]);
  expect(view.listCalls()).toHaveLength(1);
  view.unmount();
  await start();
  await waitFor(() =>
    expect(screen.getByRole("separator", { name: "모델 열 너비 조절" })).toHaveAttribute(
      "aria-valuenow",
      "96",
    ),
  );
  expect(headers().indexOf("공급자")).toBeLessThan(headers().indexOf("모델"));
});

it("기본값으로 초기화하면 표시·순서·너비를 복원한다", async () => {
  await start();
  let dialog = await openSettings();
  await userEvent.click(within(dialog).getByRole("checkbox", { name: /^공급자/u }));
  await userEvent.click(within(dialog).getByRole("button", { name: "모델 열을 왼쪽으로 이동" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "설정 완료" }));
  screen.getByRole("separator", { name: "모델 열 너비 조절" }).focus();
  await userEvent.keyboard("{Home}");
  dialog = await openSettings();
  await userEvent.click(within(dialog).getByRole("button", { name: "기본값으로 초기화" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "설정 완료" }));
  expect(headers()).toEqual([
    "시각",
    "상태",
    "요청 ID",
    "모델",
    "공급자",
    "지연 (ms)",
    "토큰 (개)",
    "비용",
    "작업",
  ]);
  expect(screen.getByRole("separator", { name: "모델 열 너비 조절" })).toHaveAttribute(
    "aria-valuenow",
    "144",
  );
  expect(localStorage.getItem(key)).toBeNull();
});

it("표시 열을 바꿔도 현재 행 선택과 전체 항목 CSV를 유지한다", async () => {
  vi.mocked(downloadCsv).mockClear();
  const view = await start();
  await userEvent.click(screen.getByRole("button", { name: "여러 요청 선택" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "1번째 요청 선택" }));
  const dialog = await openSettings();
  await userEvent.click(within(dialog).getByRole("checkbox", { name: /^모델/u }));
  await userEvent.click(within(dialog).getByRole("button", { name: "설정 완료" }));
  expect(screen.getByRole("checkbox", { name: "1번째 요청 선택" })).toBeChecked();
  await userEvent.click(screen.getByRole("button", { name: "선택한 요청 CSV" }));
  expect(downloadCsv).toHaveBeenCalledTimes(1);
  expect(vi.mocked(downloadCsv).mock.calls[0]?.[1]).toContain(row.model);
  expect(view.listCalls()).toHaveLength(1);
});

it("열 설정 도중 조회가 거부되면 대화상자와 행을 정리한다", async () => {
  const view = await start();
  const dialog = await openSettings();
  await userEvent.click(within(dialog).getByRole("checkbox", { name: /^모델/u }));
  view.replyList(async () => {
    throw new AppError("synthetic denial", { kind: "permission", status: 403 });
  });
  await act(async () => {
    await view.refresh();
  });
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.queryByRole("table")).not.toBeInTheDocument();
  expect(screen.getByRole("heading")).toHaveFocus();
  view.replyList(async () => structuredClone(list));
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await screen.findByRole("table");
  await waitFor(() => expect(headers()).not.toContain("모델"));
});

it("저장된 값에서 알 수 없는 열·원문을 제거하고 필수 열과 너비 한계를 지킨다", async () => {
  localStorage.setItem(
    key,
    JSON.stringify({
      version: 1,
      columnOrder: ["secret-raw", "model"],
      columnSizing: { model: 99999 },
      columnVisibility: { created_at: false, request_id: false, status_code: false },
      rows: [row],
    }),
  );
  await start();
  await waitFor(() => expect(headers()).not.toContain("상태"));
  expect(headers()).toContain("시각");
  expect(headers()).toContain("요청 ID");
  expect(screen.getByRole("separator", { name: "모델 열 너비 조절" })).toHaveAttribute(
    "aria-valuenow",
    "640",
  );
  expect(localStorage.getItem(key)).not.toContain("secret-raw");
  expect(localStorage.getItem(key)).not.toContain(row.request_ref);
});
