import { useEffect, useState } from "react";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { RedTeamHistoryBoundary } from "./RedTeamHistoryBoundary";
import { RedTeamEvidenceSheet } from "./RedTeamEvidenceSheet";
import { evidenceReadFixture } from "./evidence-read-fixture";
const auth = vi.hoisted(() => ({ rawPromptView: true, backendVersion: "v0.86.146" }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth(auth) };
});
const key = "GET /admin/redteam/results/public-result/evidence";
function Harness({ resultId = "public-result", visible = true }: { resultId?: string; visible?: boolean }) {
  const [, refresh] = useState(0);
  useEffect(() => {
    const listener = () => refresh((value) => value + 1);
    window.addEventListener("evidence-test-refresh", listener);
    return () => window.removeEventListener("evidence-test-refresh", listener);
  }, []);
  return (
    <FeatureAccessContext.Provider value={{ featureId: "security.redteam", permitted: true, readOnly: true }}>
      <RedTeamHistoryBoundary>
        {visible ? (
          <RedTeamEvidenceSheet
            resultId={resultId}
            canWrite={false}
            onClose={() => undefined}
            onCreateRemediation={() => undefined}
            onOpenRun={() => undefined}
            proxyKey=""
            returnFocusRef={{ current: null }}
            writeTitle="조회 전용"
          />
        ) : null}
      </RedTeamHistoryBoundary>
    </FeatureAccessContext.Provider>
  );
}
beforeEach(() => {
  auth.rawPromptView = true;
  auth.backendVersion = "v0.86.146";
});
afterEach(() => vi.restoreAllMocks());
it("원문은 버튼으로만 열고 전체 새로고침에도 재조회하지 않으며 닫으면 캐시를 비운다", async () => {
  const api = mockApi({ [key]: ({ query }) => evidenceReadFixture(Boolean(query && "reveal" in query)) });
  const user = userEvent.setup();
  const { client } = renderScreen(<Harness />);
  await screen.findByText("마스킹된 요청");
  expect(screen.queryByText("원본 요청 내용")).not.toBeInTheDocument();
  expect(api.calls).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "원문 보기" }));
  expect(await screen.findByText("원본 요청 내용")).toBeInTheDocument();
  expect(api.calls.filter((call) => call.options.query && "reveal" in call.options.query)).toHaveLength(1);
  await act(async () => {
    await client.invalidateQueries();
    await client.refetchQueries();
  });
  expect(api.calls.filter((call) => call.options.query && "reveal" in call.options.query)).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "원문 닫기" }));
  expect(screen.queryByText("원본 요청 내용")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(
      client
        .getQueryCache()
        .getAll()
        .some((q) => q.queryKey.includes("raw")),
    ).toBe(false),
  );
  await user.click(screen.getByRole("button", { name: "원문 보기" }));
  await screen.findByText("원본 요청 내용");
  expect(api.calls.filter((call) => call.options.query && "reveal" in call.options.query)).toHaveLength(2);
});
it.each(["client", "server", "absent"])(
  "권한 또는 원문이 없으면 원문 요청을 보내지 않는다: %s",
  async (reason) => {
    if (reason === "client") auth.rawPromptView = false;
    const api = mockApi({
      [key]: () => ({
        ...evidenceReadFixture(),
        raw_allowed: reason !== "server",
        raw_available: reason !== "absent",
      }),
    });
    renderScreen(<Harness />);
    await screen.findByText("마스킹된 요청");
    expect(screen.queryByRole("button", { name: "원문 보기" })).not.toBeInTheDocument();
    expect(api.calls).toHaveLength(1);
  },
);
it("이전 서버에서는 원문이 섞일 수 있는 기존 조회 API를 요청하지 않는다", async () => {
  auth.backendVersion = "v0.86.145";
  const api = mockApi({});
  renderScreen(<Harness />);
  expect(await screen.findByText("증적 조회를 위해 서버 업그레이드가 필요합니다.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "기존 화면에서 확인" })).toHaveAttribute("href", "/admin#/redteam");
  expect(api.calls).toHaveLength(0);
});
it("원문 감사 기록 실패는 자동 재시도하지 않고 수동 재시도만 허용한다", async () => {
  let failure = true;
  const api = mockApi({
    [key]: ({ query }) => {
      const raw = Boolean(query && "reveal" in query);
      if (raw && failure) throw apiFailure("감사 기록 저장 실패", 503);
      return evidenceReadFixture(raw);
    },
  });
  const user = userEvent.setup();
  const { client } = renderScreen(<Harness />);
  await user.click(await screen.findByRole("button", { name: "원문 보기" }));
  await screen.findByText("원문 증적 조회에 실패했습니다.");
  await act(async () => {
    await client.invalidateQueries();
  });
  expect(api.calls.filter((call) => call.options.query && "reveal" in call.options.query)).toHaveLength(1);
  failure = false;
  await user.click(screen.getByRole("button", { name: "원문 증적 다시 불러오기" }));
  await screen.findByText("원본 요청 내용");
});
it("늦은 원문 응답은 패널 종료 뒤 표시하거나 캐시에 남기지 않는다", async () => {
  let resolve!: (value: ReturnType<typeof evidenceReadFixture>) => void;
  const pending = new Promise<ReturnType<typeof evidenceReadFixture>>((done) => {
    resolve = done;
  });
  mockApi({ [key]: ({ query }) => (query && "reveal" in query ? pending : evidenceReadFixture()) });
  const user = userEvent.setup();
  const { client } = renderScreen(<Harness />);
  await user.click(await screen.findByRole("button", { name: "원문 보기" }));
  await user.click(screen.getByRole("button", { name: "원문 닫기" }));
  await act(async () => {
    resolve(evidenceReadFixture(true));
  });
  expect(screen.queryByText("원본 요청 내용")).not.toBeInTheDocument();
  await waitFor(() =>
    expect(
      client
        .getQueryCache()
        .getAll()
        .some((q) => q.queryKey.includes("raw")),
    ).toBe(false),
  );
});
it("원문 조회 권한 변경은 원문과 캐시를 지우고 새 조회 수명을 만든다", async () => {
  mockApi({ [key]: ({ query }) => evidenceReadFixture(Boolean(query && "reveal" in query)) });
  const user = userEvent.setup();
  const view = renderScreen(<Harness />);
  await user.click(await screen.findByRole("button", { name: "원문 보기" }));
  await screen.findByText("원본 요청 내용");
  auth.rawPromptView = false;
  await act(async () => {
    window.dispatchEvent(new Event("evidence-test-refresh"));
  });
  await waitFor(() => expect(screen.queryByText("원본 요청 내용")).not.toBeInTheDocument());
  expect(
    view.client
      .getQueryCache()
      .getAll()
      .some((q) => q.queryKey.includes("raw")),
  ).toBe(false);
});
