import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { FeatureReadOnlyBadge, MigrationEyebrow, MigrationStatusBadge } from "./MigrationStatus";
import type { MigrationStatus } from "@/config/migration-registry";
import { migrationStatusLabels } from "@/config/ui-labels";
import { ModelPageHeader } from "@/features/gateway/models/ModelPageHeader";
import { FeatureAccessContext } from "@/shared/feature-access/context";

function owner(status: MigrationStatus, children: ReactNode, readOnly = false) {
  return (
    <FeatureAccessContext.Provider value={{ featureId: "gateway.models", permitted: true, readOnly, status }}>
      {children}
    </FeatureAccessContext.Provider>
  );
}

describe("shared migration presentation", () => {
  it.each(["preview", "preview_read_only", "stable", "deprecated", "retired"] as const)(
    "%s overrides an intrinsically readonly screen's old migration label",
    (status) => {
      render(
        owner(
          status,
          <>
            <MigrationEyebrow fallbackStatus="preview_read_only" prefix="관측" />
            <FeatureReadOnlyBadge readOnly />
          </>,
        ),
      );
      expect(screen.getByRole("status", { name: "화면 전환 상태" })).toHaveTextContent(
        `관측 · ${migrationStatusLabels[status]}`,
      );
      expect(screen.getAllByText("읽기 전용", { exact: true })).toHaveLength(1);
    },
  );

  it("does not let the active route override another sidebar item's resolved state", () => {
    render(owner("stable", <MigrationStatusBadge status="legacy" />));
    expect(screen.getByText("기존 화면", { exact: true })).toBeVisible();
    expect(screen.queryByText("정식", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("the model's custom heading changes live while preserving catalogue facts and controls", () => {
    const header = (
      <ModelPageHeader
        attentionCount={0}
        availableCount={2}
        catalogueAvailable
        loading={false}
        onRefresh={() => undefined}
        refreshing={false}
        showLegacyAdmin={false}
        totalCount={2}
        virtualCount={0}
      />
    );
    const result = render(owner("preview", header));
    expect(screen.getByRole("status", { name: "화면 전환 상태" })).toHaveTextContent(/^미리보기$/);
    expect(screen.getByText("카탈로그 조회 전용")).toBeVisible();
    expect(screen.queryByText("읽기 전용", { exact: true })).not.toBeInTheDocument();
    result.rerender(owner("stable", header, true));
    expect(screen.getByRole("status", { name: "화면 전환 상태" })).toHaveTextContent(/^정식$/);
    expect(screen.getByText("카탈로그 조회 전용")).toBeVisible();
    expect(screen.getByText("읽기 전용", { exact: true })).toBeVisible();
    expect(screen.getByRole("button", { name: "새로고침" })).toBeEnabled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
