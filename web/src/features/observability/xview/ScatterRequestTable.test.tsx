import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import axe from "axe-core";
import { scatterPointSchema } from "@/shared/api/domains/observability.schemas";
import { ScatterRequestTable } from "./ScatterRequestTable";

const points = (count: number) =>
  Array.from({ length: count }, (_, index) =>
    scatterPointSchema.parse({
      request_id: `request-${index}`,
      created_at: new Date(Date.parse("2026-11-20T00:00:00Z") + index).toISOString(),
      latency_ms: index,
      model: "공개 검사 모델",
      status_code: 200,
    }),
  );
const categoryLabel = () => "정상";

it("200건 밖의 요청과 최근 요청을 서로 다른 페이지에서 골라 함께 비교한다", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(
    <ScatterRequestTable
      points={points(201)}
      metric="latency"
      categoryLabel={categoryLabel}
      onSelect={onSelect}
    />,
  );
  await user.click(screen.getByRole("checkbox", { name: "request-200 비교 대상으로 선택" }));
  await user.selectOptions(screen.getByLabelText("페이지 이동"), "4");
  await user.click(screen.getByRole("checkbox", { name: "request-0 비교 대상으로 선택" }));
  const compare = screen.getByRole("button", { name: "선택한 2건 비교" });
  await user.click(compare);
  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect.mock.calls[0]?.[0].map((point: { request_id: string }) => point.request_id)).toEqual([
    "request-0",
    "request-200",
  ]);
  expect(onSelect.mock.calls[0]?.[1]).toBe(compare);
  await user.selectOptions(screen.getByLabelText("페이지 이동"), "0");
  expect(screen.getByRole("checkbox", { name: "request-200 비교 대상으로 선택" })).toBeChecked();
});

it("6,000건 모두 선택할 수 있으며 DOM에는 현재 페이지의 50행만 둔다", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  render(
    <ScatterRequestTable
      points={points(6000)}
      metric="latency"
      categoryLabel={categoryLabel}
      onSelect={onSelect}
    />,
  );
  expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(51);
  await user.click(screen.getByRole("checkbox", { name: "산점도에 표시된 전체 6,000건 선택" }));
  await user.selectOptions(screen.getByLabelText("페이지 이동"), "119");
  expect(screen.getByRole("checkbox", { name: "request-0 비교 대상으로 선택" })).toBeChecked();
  await user.click(screen.getByRole("button", { name: "선택한 6,000건 비교" }));
  expect(onSelect.mock.calls[0]?.[0]).toHaveLength(6000);
  expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(51);
});

it("새 수신 자료로 바뀌면 이전 선택과 페이지를 버린다", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const original = points(201);
  const view = render(
    <ScatterRequestTable
      points={original}
      metric="latency"
      categoryLabel={categoryLabel}
      onSelect={onSelect}
    />,
  );
  await user.selectOptions(screen.getByLabelText("페이지 이동"), "4");
  await user.click(screen.getByRole("checkbox", { name: "request-0 비교 대상으로 선택" }));
  view.rerender(
    <ScatterRequestTable
      points={points(2)}
      metric="latency"
      categoryLabel={categoryLabel}
      onSelect={onSelect}
    />,
  );
  expect(screen.getByLabelText("페이지 이동")).toHaveValue("0");
  expect(screen.getByRole("button", { name: "선택한 요청 열기" })).toBeDisabled();
  expect(screen.getByRole("checkbox", { name: "request-0 비교 대상으로 선택" })).not.toBeChecked();
  expect(onSelect).not.toHaveBeenCalled();
});

it("단일 요청 열기와 선택 해제는 명시한 대상과 복귀 초점을 전달한다", async () => {
  const user = userEvent.setup();
  const onSelect = vi.fn();
  const original = points(2);
  render(
    <ScatterRequestTable points={original} metric="cost" categoryLabel={categoryLabel} onSelect={onSelect} />,
  );
  const open = screen.getByRole("button", { name: "request-0 선택" });
  await user.click(open);
  expect(onSelect).toHaveBeenCalledWith([original[0]], open);
  await user.click(screen.getByRole("checkbox", { name: "request-1 비교 대상으로 선택" }));
  await user.click(screen.getByRole("button", { name: "선택 해제" }));
  expect(screen.getByRole("button", { name: "선택한 요청 열기" })).toBeDisabled();
  expect(onSelect).toHaveBeenCalledTimes(1);
});

it("표시 건수를 바꿔도 같은 자료의 선택을 유지하고 표 접근성 검사를 통과한다", async () => {
  const user = userEvent.setup();
  const original = points(201);
  const view = render(
    <ScatterRequestTable
      points={original}
      metric="tokens"
      categoryLabel={categoryLabel}
      onSelect={vi.fn()}
    />,
  );
  await user.click(screen.getByRole("checkbox", { name: "request-200 비교 대상으로 선택" }));
  await user.selectOptions(screen.getByLabelText("페이지당 표시 건수"), "100");
  expect(within(screen.getByRole("table")).getAllByRole("row")).toHaveLength(101);
  expect(screen.getByRole("checkbox", { name: "request-200 비교 대상으로 선택" })).toBeChecked();
  expect((await axe.run(view.container)).violations).toEqual([]);
});
