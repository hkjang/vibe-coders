import { render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { testAuth } from "@/test/auth";
import { text2sqlHealthcheckSchema } from "@/shared/api/domains/text2sql";
import { Text2SqlHealthResult } from "./Text2SqlHealthResult";
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => testAuth() }));
function renderResult(body: unknown) {
  return render(
    <Text2SqlHealthResult connectionId="분석 연결" result={text2sqlHealthcheckSchema.parse(body)} />,
  );
}
function value(label: string): HTMLElement {
  const term = screen.getByText(label);
  return term.nextElementSibling as HTMLElement;
}
it.each([undefined, null, "true", 1])(
  "미확인 또는 잘못된 점검 값을 성공이나 실패로 단정하지 않는다: %s",
  (flag) => {
    renderResult({
      status: "preview_only",
      read_only_tx_ok: flag,
      statement_timeout_ok: flag,
      reachable: flag,
    });
    for (const label of ["DB 연결", "기본 조회", "읽기 전용 트랜잭션", "점검 제한 시간 적용"]) {
      expect(value(label)).toHaveTextContent("확인 안 함");
    }
  },
);
it("실패한 항목과 수행하지 않은 후속 점검을 구분하고 오류를 알린다", () => {
  renderResult({ status: "error", reachable: true, query_ok: false, read_only_tx_ok: null });
  expect(screen.getByRole("alert")).toBeVisible();
  expect(value("DB 연결")).toHaveTextContent("정상");
  expect(value("기본 조회")).toHaveTextContent("실패");
  expect(value("읽기 전용 트랜잭션")).toHaveTextContent("확인 안 함");
});
it("과거 서버의 계정 판정으로 계정 전체가 읽기 전용이라고 표시하지 않는다", () => {
  renderResult({
    status: "ok",
    account_write_restricted: true,
    read_only_tx_ok: true,
    statement_timeout: "5s",
    probe_timeout: "1s",
  });
  expect(value("계정 쓰기 제한")).toHaveTextContent("별도 확인 필요");
  expect(value("설정된 실행 제한 시간")).toHaveTextContent("5s");
  expect(value("점검 제한 시간")).toHaveTextContent("1s");
});
it("과거 서버에서 받은 연결 문자열을 숨기고 결과 안내를 유지한다", () => {
  renderResult({
    status: "error",
    detail: "postgres://user:private-health-sentinel@db/app",
    driver: "postgres",
  });
  expect(within(screen.getByRole("alert")).getByText("민감한 연결 정보는 표시하지 않습니다.")).toBeVisible();
  expect(document.body.textContent).not.toContain("private-health-sentinel");
});
