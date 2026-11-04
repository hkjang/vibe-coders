import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RoleChangeReview } from "./RoleChangeReview";
import { roleChanges, type RoleDraft } from "./role-changes";

const baseline: RoleDraft = {
  role: "reviewer",
  description: "검토자",
  default_home: "#/me",
  scopes: ["models:read", "future:read"],
};
describe("역할 변경 검토", () => {
  it("변경 없는 역할을 미변경으로 표시한다", () => {
    render(<RoleChangeReview baseline={baseline} draft={baseline} />);
    expect(screen.getByText("변경된 항목이 없습니다.")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("서버의 공백 정리와 권한 집합 의미를 따르며 원본 배열은 유지한다", () => {
    const draft = {
      ...baseline,
      description: " 검토자 ",
      scopes: ["future:read", "models:read", "models:read"],
    };
    expect(roleChanges(baseline, draft).changes).toEqual([]);
    expect(draft.scopes).toEqual(["future:read", "models:read", "models:read"]);
    expect(baseline.scopes).toEqual(["models:read", "future:read"]);
  });
  it("알 수 없는 권한도 제거 항목에 포함하고 한글명과 코드를 함께 표시한다", () => {
    render(<RoleChangeReview baseline={baseline} draft={{ ...baseline, scopes: ["admin:read"] }} />);
    expect(screen.getByText("권한 추가 1개 · 제거 2개")).toBeVisible();
    const row = screen.getByRole("row", { name: "기타 권한 (future:read) 부여됨 미부여" });
    expect(
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["부여됨", "미부여"]);
    expect(screen.getByRole("row", { name: "관리 정보 조회 (admin:read) 미부여 부여됨" })).toBeVisible();
  });
  it("설명과 기본 화면 제거를 서버의 빈 값 의미로 표시한다", () => {
    const { changes } = roleChanges(baseline, { ...baseline, description: "", default_home: "" });
    expect(changes).toEqual([
      { id: "description", label: "설명", before: "검토자", after: "미지정" },
      { id: "default_home", label: "기본 화면", before: "#/me", after: "서버 기본값" },
    ]);
  });
  it("새 역할의 권한을 기존 권한 상속으로 표시하지 않는다", () => {
    render(<RoleChangeReview draft={{ ...baseline, scopes: [] }} />);
    expect(screen.getByRole("row", { name: "역할 이름 새 역할 reviewer" })).toBeVisible();
    expect(screen.getByText("권한 추가 0개 · 제거 0개")).toBeVisible();
    expect(screen.queryByText(/상속/)).not.toBeInTheDocument();
  });
  it("빈 새 역할은 입력 안내를 표시한다", () => {
    render(<RoleChangeReview draft={{ role: "", description: "", default_home: "", scopes: [] }} />);
    expect(screen.getByText("역할 이름과 권한을 입력하면 변경 내용을 표시합니다.")).toBeVisible();
  });
  it("입력을 원복하면 이전 변경 표를 남기지 않는다", () => {
    const view = render(<RoleChangeReview baseline={baseline} draft={{ ...baseline, scopes: [] }} />);
    expect(screen.getByRole("table")).toBeVisible();
    view.rerender(<RoleChangeReview baseline={baseline} draft={baseline} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("권한 추가 0개 · 제거 0개")).toBeVisible();
  });
  it("설명과 기본 화면은 HTML 실행이나 링크 변환 없이 일반 텍스트로 표시한다", () => {
    const value = '<img src=x onerror="throw 1">';
    const { container } = render(
      <RoleChangeReview
        baseline={baseline}
        draft={{ ...baseline, description: value, default_home: "https://example.invalid/" }}
      />,
    );
    expect(screen.getByText(value)).toBeVisible();
    expect(container.querySelector("img, a, script")).toBeNull();
  });
});
