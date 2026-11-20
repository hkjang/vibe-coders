import { useEffect, useRef, useState } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DwRetryWorkspace } from "./DwRetryWorkspace";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { validDwRetryJobId } from "@/shared/utils/dw-retry-query";
import type { DwRetryReviewView, DwRetryRunView } from "@/shared/api/domains/dw-retry";

const runtime = vi.hoisted(() => ({ write: true, readOnly: false }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => testAuth({ scopes: runtime.write ? ["admin:read", "admin:write"] : ["admin:read"] }),
  };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const revision = "a".repeat(64);
const id = `dwr_${revision}`;
const reviewed: DwRetryReviewView = {
  revision,
  run_id: id,
  reviewed_at: "2026-11-20T06:00:00.000000000Z",
  expires_at: "2026-11-20T06:05:00.000000000Z",
  all: false,
  eligible_dimensions: 1,
  estimated_rows: 1001,
  dimensions: [
    {
      dimension: "model",
      since: "2026-11-01",
      until: "2026-11-20",
      estimated_rows: 1001,
      sent_rows: 0,
      status: "queued",
      issue: "",
    },
  ],
};
const running: DwRetryRunView = {
  id,
  status: "running",
  reviewed_at: reviewed.reviewed_at,
  created_at: reviewed.reviewed_at,
  updated_at: reviewed.reviewed_at,
  finished_at: "",
  progress: { estimated_rows: 1001, sent_rows: 0, finished_dimensions: 0, dimensions: reviewed.dimensions },
};
function Harness() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const [params, update] = useSearchState();
  const job = params.get("retry_job") ?? "";
  return (
    <>
      <button ref={ref} onClick={() => setOpen(true)}>
        실패분 재처리
      </button>
      <output aria-label="현재 주소">{params.toString()}</output>
      <DwRetryWorkspace
        open={open}
        onOpenChange={setOpen}
        canWrite={runtime.write}
        jobId={validDwRetryJobId(job) ? job : undefined}
        onJobChange={(next) => update({ retry_job: next })}
        returnFocusRef={ref}
      />
    </>
  );
}
let refreshAuthorization: () => void = () => undefined;
function Root() {
  const [, refresh] = useState(0);
  useEffect(() => {
    refreshAuthorization = () => refresh((value) => value + 1);
    return () => {
      refreshAuthorization = () => undefined;
    };
  }, []);
  return (
    <FeatureAccessContext
      value={{ featureId: "data.warehouse", permitted: true, readOnly: runtime.readOnly, status: "preview" }}
    >
      <UnsavedChangesProvider>
        <Harness />
      </UnsavedChangesProvider>
    </FeatureAccessContext>
  );
}
function render(route = "/data/warehouse") {
  return renderScreen(<Root />, { route, path: "/data/warehouse" });
}
async function open() {
  await userEvent.click(screen.getByRole("button", { name: "실패분 재처리" }));
  const dialog = await screen.findByRole("dialog", { name: "실패분 재처리 검토" });
  await within(dialog).findByRole("table", { name: "재처리 대상과 예상 건수" });
  return dialog;
}
const postKey = "POST /admin/dw/sink-retry";
const getKey = "GET /admin/dw/sink-retry";
beforeEach(() => {
  runtime.write = true;
  runtime.readOnly = false;
});
afterEach(() => {
  vi.restoreAllMocks();
});
it("대상 기간과 예상 건수를 먼저 검토하고 사유가 있어야 한 번 접수한다", async () => {
  let accept: (run: DwRetryRunView) => void = () => undefined;
  const api = mockApi({
    [getKey]: ({ query }) => (query ? running : reviewed),
    [postKey]: () =>
      new Promise<DwRetryRunView>((resolve) => {
        accept = resolve;
      }),
  });
  render();
  const dialog = await open();
  expect(api.bodies(postKey)).toHaveLength(0);
  expect(within(dialog).getByText("2026-11-01", { exact: false })).toBeInTheDocument();
  expect(within(dialog).getAllByText(/1,001/u).length).toBeGreaterThan(0);
  const submit = within(dialog).getByRole("button", { name: "검토한 대상 재처리" });
  await userEvent.click(submit);
  expect(within(dialog).getByRole("textbox", { name: /실행 사유/u })).toHaveFocus();
  expect(api.bodies(postKey)).toHaveLength(0);
  await userEvent.type(within(dialog).getByRole("textbox", { name: /실행 사유/u }), "연결 복구 후 재처리");
  await userEvent.dblClick(submit);
  await waitFor(() =>
    expect(api.bodies(postKey)).toEqual([
      { revision, reviewed_at: reviewed.reviewed_at, all: false, reason: "연결 복구 후 재처리" },
    ]),
  );
  expect(api.calls.find((call) => call.key === postKey)?.options.query).toEqual({ reviewed: "1" });
  await act(async () => accept(running));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(await screen.findByText("재처리 진행 중")).toBeInTheDocument();
  expect(screen.getByLabelText("현재 주소")).toHaveTextContent(`retry_job=${id}`);
});
it("공유된 작업 주소는 조회만 하고 일부 전송과 남은 실패를 구분한다", async () => {
  const partial: DwRetryRunView = {
    ...running,
    status: "partial_failed",
    progress: {
      ...running.progress,
      sent_rows: 1000,
      finished_dimensions: 1,
      dimensions: [
        {
          ...(reviewed.dimensions[0] ??
            (() => {
              throw new Error("missing fixture dimension");
            })()),
          sent_rows: 1000,
          status: "failed",
          issue: "delivery_incomplete",
        },
      ],
    },
  };
  const api = mockApi({ [getKey]: () => partial });
  render(`/data/warehouse?retry_job=${id}`);
  expect(await screen.findByText("일부 재처리 미완료")).toBeInTheDocument();
  expect(screen.getByText("남은 대기열을 확인하세요.")).toBeInTheDocument();
  expect(screen.getAllByText(/1,000/u).length).toBeGreaterThan(0);
  expect(api.bodies(postKey)).toHaveLength(0);
  expect(api.calls.every((call) => call.options.query && "job_id" in call.options.query)).toBe(true);
});
it("잘못된 작업 ID나 중복 파라미터는 조회하지 않는다", async () => {
  const api = mockApi({});
  render(`/data/warehouse?retry_job=${id}&retry_job=dwr_bad`);
  await waitFor(() => expect(screen.getByLabelText("현재 주소")).toBeEmptyDOMElement());
  expect(api.calls).toHaveLength(0);
});
it("검토가 변경되면 입력 사유를 보존하고 새 검토 전에는 다시 실행하지 않는다", async () => {
  let reads = 0;
  const next = {
    ...reviewed,
    revision: "b".repeat(64),
    run_id: `dwr_${"b".repeat(64)}`,
    estimated_rows: 2002,
    dimensions: [
      {
        ...(reviewed.dimensions[0] ??
          (() => {
            throw new Error("missing fixture dimension");
          })()),
        estimated_rows: 2002,
      },
    ],
  };
  const api = mockApi({
    [getKey]: ({ query }) => {
      if (query) throw apiFailure("not found", 404);
      return reads++ ? next : reviewed;
    },
    [postKey]: () => {
      throw apiFailure("changed", 409);
    },
  });
  render();
  const dialog = await open();
  await userEvent.type(within(dialog).getByRole("textbox", { name: /실행 사유/u }), "재검토 사유");
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 대상 재처리" }));
  const refresh = await within(dialog).findByRole("button", { name: "최신 대상 다시 검토" });
  expect(within(dialog).getByRole("button", { name: "검토한 대상 재처리" })).toBeDisabled();
  await userEvent.click(refresh);
  await waitFor(() => expect(within(dialog).getAllByText(/2,002/u).length).toBeGreaterThan(0));
  expect(within(dialog).getByRole("textbox", { name: /실행 사유/u })).toHaveValue("재검토 사유");
  expect(api.bodies(postKey)).toHaveLength(1);
  expect(within(dialog).getByRole("button", { name: "검토한 대상 재처리" })).toBeEnabled();
});
it("접수 응답이 유실되면 기존 작업 조회로 복구하고 POST를 재시도하지 않는다", async () => {
  let releaseInitialRead: () => void = () => undefined;
  const initialRead = new Promise<DwRetryRunView>((resolve) => {
    releaseInitialRead = () => resolve(running);
  });
  const api = mockApi({
    [getKey]: ({ query }) => (query ? initialRead : reviewed),
    [postKey]: () => {
      throw apiFailure("response lost", 503);
    },
  });
  render();
  const dialog = await open();
  await userEvent.type(within(dialog).getByRole("textbox", { name: /실행 사유/u }), "복구 사유");
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 대상 재처리" }));
  const recover = await within(dialog).findByRole("button", { name: "접수 결과 확인" });
  await waitFor(() => expect(recover).toBeDisabled());
  // A click during the automatic status read is intentionally ignored. Wait
  // for that read to finish before exercising the explicit recovery action.
  await userEvent.click(recover);
  await act(async () => releaseInitialRead());
  await waitFor(() => expect(recover).toBeEnabled());
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  await userEvent.click(recover);
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(api.bodies(postKey)).toHaveLength(1);
  expect(await screen.findByText("재처리 진행 중")).toBeInTheDocument();
});
it.each(["권한 회수", "미리보기 읽기 전용"])("%s 시 열린 검토에서도 실행을 차단한다", async (mode) => {
  const api = mockApi({ [getKey]: () => reviewed });
  render();
  const dialog = await open();
  await userEvent.type(within(dialog).getByRole("textbox", { name: /실행 사유/u }), "보존할 사유");
  if (mode === "권한 회수") runtime.write = false;
  else runtime.readOnly = true;
  act(() => refreshAuthorization());
  expect(within(dialog).getByRole("button", { name: "검토한 대상 재처리" })).toBeDisabled();
  expect(within(dialog).getByRole("textbox", { name: /실행 사유/u })).toHaveValue("보존할 사유");
  expect(api.bodies(postKey)).toHaveLength(0);
});
it("검토 오류에서는 실행하지 않고 키보드와 접근성 안내를 유지한다", async () => {
  const api = mockApi({
    [getKey]: () => {
      throw apiFailure("source unavailable", 503);
    },
  });
  render();
  await userEvent.click(screen.getByRole("button", { name: "실패분 재처리" }));
  const dialog = await screen.findByRole("dialog");
  await within(dialog).findByRole("button", { name: /다시/u });
  expect(within(dialog).getByRole("button", { name: "검토한 대상 재처리" })).toBeDisabled();
  const audit = await axe.run(dialog, { rules: { "color-contrast": { enabled: false } } });
  expect(audit.violations).toEqual([]);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "실패분 재처리" })).toHaveFocus();
  expect(api.bodies(postKey)).toHaveLength(0);
});
it("작성 중인 사유가 있으면 닫기 전에 폐기를 확인한다", async () => {
  mockApi({ [getKey]: () => reviewed });
  render();
  const dialog = await open();
  await userEvent.type(within(dialog).getByRole("textbox", { name: /실행 사유/u }), "아직 작성 중");
  await userEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
  expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
  expect(screen.getByLabelText(/실행 사유/u)).toHaveValue("아직 작성 중");
});
it("다른 계정의 작업 조회가 거절되면 조회를 멈추고 권한 안내를 표시한다", async () => {
  const api = mockApi({
    [getKey]: () => {
      throw apiFailure("foreign job", 403);
    },
  });
  render(`/data/warehouse?retry_job=${id}`);
  expect(await screen.findByText("재처리 작업 조회 권한을 확인하세요.")).toBeInTheDocument();
  expect(screen.queryByText("작업 상태를 확인하고 있습니다.")).not.toBeInTheDocument();
  expect(api.bodies(postKey)).toHaveLength(0);
  await userEvent.click(screen.getByRole("button", { name: "작업 주소 지우기" }));
  await waitFor(() => expect(screen.getByLabelText("현재 주소")).toBeEmptyDOMElement());
});
it("완료된 작업 뒤 같은 화면에서 새 실패분을 다시 검토하고 접수한다", async () => {
  let reviews = 0;
  const next = {
    ...reviewed,
    revision: "b".repeat(64),
    run_id: `dwr_${"b".repeat(64)}`,
    estimated_rows: 2002,
  };
  const partial: DwRetryRunView = { ...running, status: "partial_failed" };
  const api = mockApi({
    [getKey]: ({ query }) =>
      query ? { ...partial, id: "job_id" in query ? String(query.job_id) : id } : reviews++ ? next : reviewed,
    [postKey]: ({ body }) => ({ ...partial, id: `dwr_${(body as { revision: string }).revision}` }),
  });
  render();
  let dialog = await open();
  await userEvent.type(within(dialog).getByRole("textbox", { name: /실행 사유/u }), "첫 번째 실패 복구");
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 대상 재처리" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(await screen.findByText("일부 재처리 미완료")).toBeInTheDocument();
  dialog = await open();
  await within(dialog).findByText(/예상 2,002행/u);
  const reason = within(dialog).getByRole("textbox", { name: /실행 사유/u });
  expect(reason).toBeEnabled();
  expect(reason).toHaveValue("");
  await userEvent.type(reason, "남은 실패분 재검토");
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 대상 재처리" }));
  await waitFor(() => expect(api.bodies(postKey)).toHaveLength(2));
  expect(api.bodies(postKey)[1]).toEqual({
    revision: next.revision,
    reviewed_at: next.reviewed_at,
    all: false,
    reason: "남은 실패분 재검토",
  });
});

it("접수 여부를 확인하지 못한 검토는 닫았다 다시 열어도 재전송 잠금을 유지한다", async () => {
  const api = mockApi({
    [getKey]: ({ query }) => {
      if (query) throw apiFailure("unknown job", 404);
      return reviewed;
    },
    [postKey]: () => {
      throw apiFailure("response lost", 503);
    },
  });
  render();
  let dialog = await open();
  await userEvent.type(
    within(dialog).getByRole("textbox", { name: /실행 사유/u }),
    "접수 확인 전 재전송 금지",
  );
  await userEvent.click(within(dialog).getByRole("button", { name: "검토한 대상 재처리" }));
  await within(dialog).findByRole("button", { name: "접수 결과 확인" });
  await userEvent.click(within(dialog).getByRole("button", { name: /^닫기$/u }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  dialog = await open();
  expect(within(dialog).getByRole("textbox", { name: /실행 사유/u })).toBeDisabled();
  expect(within(dialog).getByRole("button", { name: "검토한 대상 재처리" })).toBeDisabled();
  expect(api.bodies(postKey)).toHaveLength(1);
});
