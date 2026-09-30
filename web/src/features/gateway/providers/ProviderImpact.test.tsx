import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ProviderDeleteDialog } from "@/features/gateway/providers/ProviderDeleteDialog";
import { ProviderEditDialog } from "@/features/gateway/providers/ProviderEditDialog";
import { providerImpactAcknowledgement } from "@/features/gateway/providers/ProviderImpactPanel";
import { useProviderAdministration } from "@/features/gateway/providers/use-provider-administration";
import { buildProviderRows } from "@/features/gateway/providers/provider-catalog";
import {
  impactSection,
  providerImpactFixture,
} from "@/features/gateway/providers/provider-impact-test-fixtures";
import { apiClient } from "@/shared/api/client";
import type { ProviderImpact } from "@/shared/api/domains/provider-impact";
import { apiFailure, mockApi } from "@/test/api";
import { FeatureAccessHarness } from "@/test/feature-access";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});

const providerRef = `prv_${"a".repeat(43)}`;
const providerName = "public-impact-provider";
const provider = {
  provider_ref: providerRef,
  name: providerName,
  base_url: "https://provider.example.invalid/v1",
  timeout_ms: 30000,
  priority: 10,
  enabled: true,
  api_key_configured: true,
  model_patterns: "public-*",
  failover_group: "public-group",
  created_at: "2026-09-01T00:00:00Z",
};
function fixtureRow() {
  const result = buildProviderRows([provider])[0];
  if (!result) throw new Error("missing synthetic provider");
  return result;
}
const row = fixtureRow();

function Harness({
  mode = "delete",
  action = async () => undefined,
  credentialPrefixes,
}: {
  mode?: "delete" | "edit";
  action?: (...args: unknown[]) => Promise<unknown>;
  credentialPrefixes?: readonly string[];
}) {
  const [open, setOpen] = useState(true);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={trigger} onClick={() => setOpen(true)}>
        열기
      </button>
      {open ? (
        mode === "delete" ? (
          <ProviderDeleteDialog
            row={row}
            credentialPrefixes={credentialPrefixes}
            onDelete={action}
            onOpenChange={setOpen}
            returnFocusRef={trigger}
          />
        ) : (
          <ProviderEditDialog
            row={row}
            credentialPrefixes={credentialPrefixes}
            onSubmit={action}
            onOpenChange={setOpen}
            returnFocusRef={trigger}
          />
        )
      ) : null}
    </>
  );
}

function renderImpact(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    client,
    ...render(ui, {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>
          <FeatureAccessHarness featureId="gateway.providers">{children}</FeatureAccessHarness>
        </QueryClientProvider>
      ),
    }),
  };
}

function AdministrationHarness() {
  const administration = useProviderAdministration(true, ["corp_"]);
  return (
    <>
      {administration.renderRowActions(row)}
      {administration.dialogs}
    </>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function consent() {
  return screen.getByRole("checkbox", { name: new RegExp(providerImpactAcknowledgement) });
}

async function acknowledge(user: ReturnType<typeof userEvent.setup>) {
  await waitFor(() => expect(consent()).toBeEnabled());
  await user.click(consent());
}

function deleteButton() {
  return screen.getByRole("button", { name: "삭제" });
}

function deleteForm() {
  const form = screen.getByLabelText("삭제 대상 재입력").closest("form");
  if (!form) throw new Error("missing confirmation form");
  return form;
}

describe("공급자 현재 설정 영향 조회", () => {
  it.each([
    ["edit", "dialog"],
    ["delete", "dialog"],
    ["edit", "administration"],
    ["delete", "administration"],
  ] as const)("%s %s 확인창은 인증 설정의 접두사가 포함된 참조 이름과 모델을 숨긴다", async (mode, entry) => {
    const user = userEvent.setup();
    const label = `corp_${"L".repeat(40)}`;
    const model = `corp_${"M".repeat(40)}`;
    const reference = `impact_${"c".repeat(43)}`;
    mockApi({
      "GET /admin/provider-impact": () =>
        providerImpactFixture(providerRef, {
          routing_rules: impactSection({
            scanned_count: 2,
            matched_count: 2,
            items: [
              { reference, label, model, enabled: true },
              {
                reference: `impact_${"d".repeat(43)}`,
                label: "공개 라우팅 규칙",
                model: "public-model",
                enabled: true,
              },
            ],
          }),
        }),
    });
    const view = renderImpact(
      entry === "administration" ? (
        <AdministrationHarness />
      ) : (
        <Harness mode={mode} credentialPrefixes={["corp_"]} />
      ),
    );
    if (entry === "administration") {
      await user.click(screen.getByRole("button", { name: mode === "edit" ? "수정" : "삭제" }));
    }
    if (mode === "edit") {
      await user.clear(screen.getByLabelText("우선순위"));
      await user.type(screen.getByLabelText("우선순위"), "30");
      await user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    }
    const section = await screen.findByRole("region", { name: "라우팅 규칙" });
    await within(section).findByText(reference);
    expect(view.baseElement.innerHTML).not.toContain(label);
    expect(view.baseElement.innerHTML).not.toContain(model);
    expect(within(section).getByText("비공개 항목")).toBeInTheDocument();
    expect(within(section).getByText("· 모델: 비공개")).toBeInTheDocument();
    expect(within(section).getByText("공개 라우팅 규칙")).toBeInTheDocument();
    expect(within(section).getByText("· 모델: public-model")).toBeInTheDocument();
  });

  it("조회 중에는 정확한 삭제 이름을 입력해도 제출하지 않으며 결과별 동의를 요구한다", async () => {
    const user = userEvent.setup();
    const request = deferred<ProviderImpact>();
    const api = mockApi({ "GET /admin/provider-impact": () => request.promise });
    const action = vi.fn(async () => undefined);
    const { client } = renderImpact(<Harness action={action} />);
    await user.type(screen.getByLabelText("삭제 대상 재입력"), providerName);
    expect(consent()).toBeDisabled();
    expect(deleteButton()).toBeDisabled();
    fireEvent.submit(deleteForm());
    expect(action).not.toHaveBeenCalled();
    expect(api.calls).toEqual([
      {
        key: "GET /admin/provider-impact",
        options: { body: undefined, query: { provider_ref: providerRef } },
      },
    ]);
    expect(
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toEqual([["admin", "providers", "impact", providerRef]]);
    await act(async () => request.resolve(providerImpactFixture(providerRef)));
    expect(deleteButton()).toBeDisabled();
    expect(await screen.findByText(/서버 조회 시각/)).toBeInTheDocument();
    await acknowledge(user);
    expect(deleteButton()).toBeEnabled();
    await user.click(deleteButton());
    await waitFor(() => expect(action).toHaveBeenCalledExactlyOnceWith(providerName));
  });

  it("최소 0건을 완전한 0건과 구분하고 권한 거부·조회 실패를 미확인으로 표시한다", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /admin/provider-impact": () =>
        providerImpactFixture(providerRef, {
          is_default: true,
          bootstrap_on_restart: true,
          routing_rules: impactSection({
            status: "partial",
            count_kind: "lower_bound",
            truncated: true,
            scanned_count: 1024,
            matched_count: 0,
            reason: "bounded_or_unassessable_configuration",
          }),
          agent_routes: impactSection({
            status: "denied",
            count_kind: "unknown",
            scanned_count: null,
            matched_count: null,
            reason: "routing_read_required",
          }),
          teams: impactSection({
            status: "unavailable",
            count_kind: "unknown",
            scanned_count: null,
            matched_count: null,
            reason: "team_configuration_read_failed",
            scope: "teams_of_eligible_key_configuration",
          }),
        }),
    });
    renderImpact(<Harness />);
    await waitFor(() => expect(consent()).toBeEnabled());
    expect(
      within(screen.getByRole("region", { name: "라우팅 규칙" })).getByText("확인된 최소 0건 · 전체 미확인"),
    ).toBeInTheDocument();
    const denied = screen.getByRole("region", { name: "에이전트 경로" });
    expect(denied).toHaveTextContent("routing:read");
    expect(denied).toHaveTextContent("확인하지 못함");
    expect(denied).not.toHaveTextContent("0건");
    const unavailable = screen.getByRole("region", { name: "관련 팀 설정" });
    expect(unavailable).toHaveTextContent("확인하지 못함");
    expect(unavailable).not.toHaveTextContent("0건");
    expect(screen.getByText(/기본 공급자입니다/)).toBeInTheDocument();
    expect(screen.getByText(/재시작 후 다시 생성/)).toBeInTheDocument();
    await acknowledge(user);
    expect(consent()).toBeChecked();
  });

  it("많은 참조는 10개씩 렌더링하고 다음 조회의 페이지는 처음부터 표시한다", async () => {
    const user = userEvent.setup();
    let count = 25;
    mockApi({
      "GET /admin/provider-impact": () =>
        providerImpactFixture(providerRef, {
          routing_rules: impactSection({
            scanned_count: count,
            matched_count: count,
            items: Array.from({ length: count }, (_, index) => ({
              reference: `impact_${String(index).padStart(43, "a")}`,
              label: `규칙-${String(index + 1).padStart(2, "0")}`,
              enabled: true,
            })),
          }),
        }),
    });
    renderImpact(<Harness />);
    const section = await screen.findByRole("region", { name: "라우팅 규칙" });
    await within(section).findByText("규칙-01");
    expect(within(section).getAllByRole("listitem")).toHaveLength(10);
    expect(within(section).queryByText("규칙-11")).not.toBeInTheDocument();
    await user.click(within(section).getByRole("button", { name: "다음" }));
    expect(within(section).getByText("규칙-11")).toBeInTheDocument();
    expect(within(section).queryByText("규칙-01")).not.toBeInTheDocument();
    count = 2;
    await user.click(screen.getByRole("button", { name: "참조 영향 다시 조회" }));
    await within(section).findByText("규칙-01");
    expect(within(section).getAllByRole("listitem")).toHaveLength(2);
    expect(within(section).queryByRole("navigation")).not.toBeInTheDocument();
  });

  it("재조회와 같은 tick 제출은 이전 동의를 사용할 수 없고 실패 결과도 다시 읽고 동의해야 한다", async () => {
    const user = userEvent.setup();
    const request = deferred<ProviderImpact>();
    let calls = 0;
    mockApi({
      "GET /admin/provider-impact": () =>
        ++calls === 1 ? providerImpactFixture(providerRef) : request.promise,
    });
    const action = vi.fn(async () => undefined);
    renderImpact(<Harness action={action} />);
    await user.type(screen.getByLabelText("삭제 대상 재입력"), providerName);
    await acknowledge(user);
    act(() => {
      fireEvent.click(screen.getByRole("button", { name: "참조 영향 다시 조회" }));
      fireEvent.submit(deleteForm());
    });
    expect(action).not.toHaveBeenCalled();
    expect(consent()).not.toBeChecked();
    expect(consent()).toBeDisabled();
    await act(async () => request.reject(apiFailure("private server detail", 503, "req-impact-safe")));
    expect(await screen.findByRole("alert")).toHaveTextContent("req-impact-safe");
    expect(screen.getByRole("alert")).toHaveTextContent("영향이 없다는 뜻이 아닙니다");
    expect(screen.queryByText(/서버 조회 시각/)).not.toBeInTheDocument();
    expect(screen.queryByText("설정 참조 0건")).not.toBeInTheDocument();
    expect(deleteButton()).toBeDisabled();
    expect(calls).toBe(2);
    await acknowledge(user);
    await user.click(deleteButton());
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });

  it("편집 중에는 조회하지 않고 재편집은 동의를 버리며 조회에는 편집 payload를 보내지 않는다", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /admin/provider-impact": () => providerImpactFixture(providerRef) });
    const action = vi.fn(async () => undefined);
    renderImpact(<Harness mode="edit" action={action} />);
    await user.clear(screen.getByLabelText("우선순위"));
    await user.type(screen.getByLabelText("우선순위"), "30");
    expect(api.calls).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    await acknowledge(user);
    await user.click(screen.getByRole("button", { name: "다시 편집" }));
    await user.clear(screen.getByLabelText("우선순위"));
    await user.type(screen.getByLabelText("우선순위"), "40");
    await user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    await waitFor(() => expect(consent()).toBeEnabled());
    expect(consent()).not.toBeChecked();
    expect(screen.getByRole("button", { name: "검토한 내용 저장" })).toBeDisabled();
    expect(
      api.calls.every(
        (call) =>
          call.options.body === undefined &&
          JSON.stringify(call.options.query) === JSON.stringify({ provider_ref: providerRef }),
      ),
    ).toBe(true);
    await acknowledge(user);
    await user.click(screen.getByRole("button", { name: "검토한 내용 저장" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0]).toEqual([expect.objectContaining({ priority: 40 })]);
  });

  it("다른 공급자 응답은 계약 오류로 거부하며 데이터와 기본 공급자 경고를 표시하지 않는다", async () => {
    mockApi({
      "GET /admin/provider-impact": () =>
        providerImpactFixture(`prv_${"b".repeat(43)}`, { is_default: true }),
    });
    renderImpact(<Harness />);
    expect(await screen.findByRole("alert")).toHaveTextContent("참조 영향을 조회하지 못했습니다");
    expect(screen.queryByText(/서버 조회 시각/)).not.toBeInTheDocument();
    expect(screen.queryByText(/기본 공급자입니다/)).not.toBeInTheDocument();
    expect(screen.queryByText("설정 참조 0건")).not.toBeInTheDocument();
  });

  it("동일한 내용의 성공 재조회도 이전 동의를 되살리지 않는다", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /admin/provider-impact": () => providerImpactFixture(providerRef) });
    const action = vi.fn(async () => undefined);
    renderImpact(<Harness action={action} />);
    await user.type(screen.getByLabelText("삭제 대상 재입력"), providerName);
    await acknowledge(user);
    expect(deleteButton()).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "참조 영향 다시 조회" }));
    await waitFor(() => expect(consent()).toBeEnabled());
    expect(api.calls).toHaveLength(2);
    expect(consent()).not.toBeChecked();
    expect(deleteButton()).toBeDisabled();
    fireEvent.submit(deleteForm());
    expect(action).not.toHaveBeenCalled();
    await acknowledge(user);
    await user.click(deleteButton());
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
  });

  it("구버전 서버의 404도 0건이 아닌 미조회로 안내하고 재시도나 위험 동의로 이어진다", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /admin/provider-impact": () => {
        throw apiFailure("not available", 404);
      },
    });
    const action = vi.fn(async () => undefined);
    renderImpact(<Harness action={action} />);
    await screen.findByRole("alert");
    expect(screen.queryByText("설정 참조 0건")).not.toBeInTheDocument();
    expect(screen.getAllByText("확인하지 못함")).toHaveLength(5);
    await user.type(screen.getByLabelText("삭제 대상 재입력"), providerName);
    expect(deleteButton()).toBeDisabled();
    await acknowledge(user);
    await user.click(deleteButton());
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(api.calls).toHaveLength(1);
  });

  it("대기 중에는 영향 갱신과 동의를 잠그며 중복 삭제를 만들지 않는다", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "GET /admin/provider-impact": () => providerImpactFixture(providerRef) });
    const operation = deferred<undefined>();
    const action = vi.fn(() => operation.promise);
    renderImpact(<Harness action={action} />);
    await user.type(screen.getByLabelText("삭제 대상 재입력"), providerName);
    await acknowledge(user);
    act(() => {
      fireEvent.submit(deleteForm());
      fireEvent.submit(deleteForm());
    });
    expect(action).toHaveBeenCalledTimes(1);
    expect(consent()).toBeDisabled();
    expect(screen.getByRole("button", { name: "참조 영향 다시 조회" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "참조 영향 다시 조회" }));
    expect(api.calls).toHaveLength(1);
    await act(async () => operation.resolve(undefined));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("닫을 때 요청을 취소하고 메모리 query를 제거하며 재열 때 새 결과를 조회한다", async () => {
    let signal: AbortSignal | undefined;
    const api = vi.spyOn(apiClient, "request").mockImplementation(async (_endpoint, ...args) => {
      signal = args[0]?.signal;
      return await new Promise<never>(() => undefined);
    });
    const view = renderImpact(<Harness />);
    await waitFor(() => expect(api).toHaveBeenCalledTimes(1));
    expect(signal?.aborted).toBe(false);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await waitFor(() => expect(view.client.getQueryCache().getAll()).toHaveLength(0));
    api.mockResolvedValue(providerImpactFixture(providerRef) as never);
    renderImpact(<Harness />);
    await waitFor(() => expect(consent()).toBeEnabled());
    expect(api).toHaveBeenCalledTimes(2);
    expect(consent()).not.toBeChecked();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
