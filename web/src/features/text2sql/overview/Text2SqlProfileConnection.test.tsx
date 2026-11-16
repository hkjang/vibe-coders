import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Text2SqlProfileConnection } from "./Text2SqlProfileConnection";
import { featureLabel } from "./text2sql-labels";

it("연결 목록을 조회하지 못해도 기본 DB 선택은 기본 DB로 표시한다", () => {
  render(<Text2SqlProfileConnection id=" default " connections={[]} loading={false} error={new Error()} />);
  expect(screen.getByText("기본 DB (서버 설정)")).toBeVisible();
  expect(screen.queryByText("등록되지 않은 연결")).not.toBeInTheDocument();
});

it("이름 있는 연결은 조회 중과 확인된 미등록 상태를 구분하며 기본 DB로 표시하지 않는다", () => {
  const view = render(<Text2SqlProfileConnection id="named" connections={[]} loading error={null} />);
  expect(screen.getByText("연결 확인 중")).toBeVisible();
  expect(screen.queryByText("등록되지 않은 연결")).not.toBeInTheDocument();
  view.rerender(<Text2SqlProfileConnection id="named" connections={[]} loading={false} error={null} />);
  expect(screen.getByText("named")).toBeVisible();
  expect(screen.getByText("등록되지 않은 연결")).toBeVisible();
  expect(screen.queryByText("기본 DB (서버 설정)")).not.toBeInTheDocument();
});

it("새 서버 기능의 의미를 추측하지 않고 원래 식별자를 유지한다", () => {
  expect(featureLabel("future_feature")).toBe("추가 기능 (future_feature)");
});
