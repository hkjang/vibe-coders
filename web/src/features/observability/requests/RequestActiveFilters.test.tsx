import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import { RequestActiveFilters } from "./RequestActiveFilters";
import { requestFilterSummary, withoutRequestFilter } from "./request-filter-summary";
import { queryFromSearch } from "./request-page-query";
import { list, renderRequests } from "./request-safe-flow-test-harness";

it("조회 조건만 요약하고 상태를 한글로 표시한다", () => {
  const query = queryFromSearch(new URLSearchParams("model=한글+모델&status=5xx&ip=invalid&limit=25&tz=UTC"));
  expect(requestFilterSummary(query, [])).toEqual([
    { key: "status", label: "상태", value: "서버 오류 (5xx)" },
    { key: "model", label: "모델", value: "한글 모델" },
  ]);
});

it("비밀값은 요약과 제목에 다시 노출하지 않는다", () => {
  const secret = `corp_${"x".repeat(32)}`;
  render(
    <RequestActiveFilters
      query={{ model: secret }}
      credentialPrefixes={["corp_"]}
      current
      onRemove={vi.fn()}
    />,
  );
  const summary = screen.getByRole("region", { name: "요청 조회 조건" });
  expect(summary).toHaveTextContent("[값 비공개]");
  expect(summary.innerHTML).not.toContain(secret);
  expect(within(summary).getByTitle("[값 비공개]")).toBeInTheDocument();
});

it("한 조건과 페이지 위치만 제거하고 나머지 주소를 보존한다", () => {
  const search = new URLSearchParams("model=a&model=b&language=ko&limit=25&tz=UTC&cursor=page");
  const next = withoutRequestFilter(search, "model");
  expect(next.toString()).toBe("language=ko&limit=25&tz=UTC");
  expect(search.getAll("model")).toEqual(["a", "b"]);
  expect(search.get("cursor")).toBe("page");
});

it("조회 중이거나 실패한 조건을 현재 행에 적용됐다고 표시하지 않는다", () => {
  const view = render(
    <RequestActiveFilters
      query={{ model: "공개 모델" }}
      credentialPrefixes={[]}
      current={false}
      onRemove={vi.fn()}
    />,
  );
  expect(screen.getByRole("region")).toHaveTextContent("조회 요청 조건 1개");
  view.rerender(
    <RequestActiveFilters
      query={{ model: "공개 모델" }}
      credentialPrefixes={[]}
      current
      onRemove={vi.fn()}
    />,
  );
  expect(screen.getByRole("region")).toHaveTextContent("적용 중인 조건 1개");
});

it("키보드 해제는 해당 조건 키만 전달하고 접근성 오류가 없다", async () => {
  const remove = vi.fn();
  render(
    <RequestActiveFilters
      query={{ model: "긴 모델", session_id: "session-a", limit: 25, tz: "UTC" }}
      credentialPrefixes={[]}
      current
      onRemove={remove}
    />,
  );
  screen.getByRole("button", { name: "세션 ID 필터 해제" }).focus();
  await userEvent.keyboard("{Enter}");
  expect(remove).toHaveBeenCalledExactlyOnceWith("session_id");
  expect(screen.getByRole("region")).toHaveTextContent("표시 시간대 UTC · 페이지당 25건");
  expect((await axe.run(screen.getByRole("region"))).violations).toEqual([]);
});

it("새로 입력한 초안과 적용 조건을 구분하고 개별 해제 후 결과로 포커스를 옮긴다", async () => {
  const view = renderRequests();
  await screen.findByRole("table");
  await act(async () => view.navigate("?model=applied-model&session_id=session-a&limit=25&tz=UTC"));
  const summary = await screen.findByRole("region", { name: "요청 조회 조건" });
  await waitFor(() => expect(summary).toHaveTextContent("적용 중인 조건 2개"));
  expect(screen.getByText("1개 적용")).toBeInTheDocument();
  await userEvent.clear(screen.getByLabelText("모델", { exact: true }));
  await userEvent.type(screen.getByLabelText("모델", { exact: true }), "unapplied-model");
  expect(summary).toHaveTextContent("applied-model");
  expect(summary).not.toHaveTextContent("unapplied-model");
  await userEvent.click(within(summary).getByRole("button", { name: "모델 필터 해제" }));
  await waitFor(() =>
    expect(view.listCalls().at(-1)?.query).toEqual({ session_id: "session-a", limit: 25, tz: "UTC" }),
  );
  await waitFor(() => expect(screen.getByRole("heading", { name: "요청 조회 결과" })).toHaveFocus());
  expect(screen.getByLabelText("모델", { exact: true })).toHaveValue("");
  expect(summary).not.toHaveTextContent("applied-model");
});

it("조건 해제는 선택을 정리하며 403 뒤 이전 요약도 제거한다", async () => {
  const view = renderRequests();
  await screen.findByRole("table");
  await act(async () => view.navigate("?model=test-model"));
  await waitFor(() =>
    expect(screen.getByRole("region", { name: "요청 조회 조건" })).toHaveTextContent("적용 중인 조건 1개"),
  );
  await userEvent.click(screen.getByRole("button", { name: "여러 요청 선택" }));
  await userEvent.click(screen.getByRole("checkbox", { name: "1번째 요청 선택" }));
  await userEvent.click(screen.getByRole("button", { name: "모델 필터 해제" }));
  await waitFor(() => expect(screen.getByRole("checkbox", { name: "1번째 요청 선택" })).not.toBeChecked());
  expect(screen.getByRole("region", { name: "요청 조회 조건" })).toHaveTextContent(
    "별도 조건 없이 최근 요청",
  );
  view.replyList(async () => {
    throw new AppError("synthetic denial", { kind: "permission", status: 403 });
  });
  await act(async () => view.refresh());
  await waitFor(() =>
    expect(screen.queryByRole("region", { name: "요청 조회 조건" })).not.toBeInTheDocument(),
  );
  view.replyList(async () => structuredClone(list));
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByRole("region", { name: "요청 조회 조건" })).toHaveTextContent(
    "적용 중인 조건 0개",
  );
});
