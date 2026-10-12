import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PageHeader } from "./PageHeader";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry, type MigrationFeature } from "@/config/migration-registry";
import { migrationStatusLabels } from "@/config/ui-labels";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { testAuth } from "@/test/auth";

const runtime = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => runtime.auth }));

const feature = (() => {
  const entry = migrationRegistry.find((candidate) => candidate.featureId === "text2sql.overview");
  if (!entry) throw new Error("Missing Text2SQL test feature");
  return entry;
})();
function setFeature(patch: Partial<MigrationFeature>) {
  runtime.auth = { ...runtime.auth, features: [{ ...feature, ...patch }] };
}
function routedHeader(readOnly = false) {
  return (
    <FeatureRoute feature={feature}>
      <PageHeader title="자연어 SQL" status="legacy" readOnly={readOnly} legacyHref="/admin#/text2sql" />
    </FeatureRoute>
  );
}
beforeEach(() => {
  runtime.auth = testAuth();
  setFeature({ status: "preview", readOnly: false, serverAvailable: true });
});

describe("PageHeader runtime migration presentation", () => {
  it.each(["preview", "preview_read_only", "stable", "deprecated", "retired"] as const)(
    "%s uses the route guard state instead of a stale screen label",
    (status) => {
      setFeature({ status });
      render(routedHeader());
      expect(screen.getByLabelText("화면 전환 상태")).toHaveTextContent(migrationStatusLabels[status]);
      expect(screen.getByRole("heading", { name: "자연어 SQL" })).toBeVisible();
    },
  );

  it("updates status and readonly together without a page reload", () => {
    const result = render(routedHeader());
    expect(screen.queryByText("읽기 전용", { exact: true })).not.toBeInTheDocument();
    setFeature({ status: "preview_read_only", readOnly: false, serverAvailable: true });
    result.rerender(routedHeader());
    expect(screen.getByLabelText("화면 전환 상태")).toHaveTextContent("읽기 전용 미리보기");
    expect(screen.getAllByText("읽기 전용", { exact: true })).toHaveLength(1);
    setFeature({ status: "preview", readOnly: false, serverAvailable: true });
    result.rerender(routedHeader());
    expect(screen.getByLabelText("화면 전환 상태")).toHaveTextContent("미리보기");
    expect(screen.queryByText("읽기 전용", { exact: true })).not.toBeInTheDocument();
  });

  it("a readonly override does not falsely change preview into another migration status", () => {
    setFeature({ status: "preview", readOnly: true, serverAvailable: true });
    render(routedHeader(false));
    expect(screen.getByLabelText("화면 전환 상태")).toHaveTextContent(/^미리보기$/);
    expect(screen.getAllByText("읽기 전용", { exact: true })).toHaveLength(1);
  });

  it("preserves a screen's stricter readonly permission without a duplicate badge", () => {
    const result = render(routedHeader(true));
    expect(screen.getAllByText("읽기 전용", { exact: true })).toHaveLength(1);
    setFeature({ readOnly: true, serverAvailable: true });
    result.rerender(routedHeader(true));
    expect(screen.getAllByText("읽기 전용", { exact: true })).toHaveLength(1);
  });

  it("continues to render the legacy bridge rather than the React screen after demotion", () => {
    const result = render(routedHeader());
    setFeature({ status: "legacy", serverAvailable: true });
    result.rerender(routedHeader());
    expect(screen.queryByRole("heading", { name: "자연어 SQL" })).not.toBeInTheDocument();
    expect(screen.getByText("기존 화면 연결")).toBeVisible();
    expect(screen.getByRole("link", { name: /기존 화면에서/ })).toHaveAttribute("href", feature.legacyPath);
  });

  it("never mounts the React heading when access is revoked", () => {
    const result = render(routedHeader());
    setFeature({ serverAvailable: false, availabilityReason: "permission_denied" });
    result.rerender(routedHeader());
    expect(screen.queryByLabelText("화면 전환 상태")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("접근 권한이 없습니다.");
  });

  it("retains the API-version legacy fallback rather than trusting the configured status", () => {
    runtime.auth = { ...runtime.auth, backendVersion: "v0.1.0" };
    render(routedHeader());
    expect(screen.queryByLabelText("화면 전환 상태")).not.toBeInTheDocument();
    expect(screen.getByText("기존 화면 연결")).toBeVisible();
  });

  it("keeps an explicit fallback status outside a feature route", () => {
    render(<PageHeader title="별도 화면" status="preview_read_only" />);
    expect(screen.getByLabelText("화면 전환 상태")).toHaveTextContent("읽기 전용 미리보기");
    expect(screen.getByText("읽기 전용", { exact: true })).toBeVisible();
  });

  it("does not treat an unpermitted context as an authoritative migration status", () => {
    render(
      <FeatureAccessContext.Provider
        value={{ featureId: feature.featureId, permitted: false, readOnly: true, status: "stable" }}
      >
        <PageHeader title="별도 화면" />
      </FeatureAccessContext.Provider>,
    );
    expect(screen.getByLabelText("화면 전환 상태")).toHaveTextContent(/^미리보기$/);
    expect(screen.getByText("읽기 전용", { exact: true })).toBeVisible();
  });

  it("keeps the migration label when a section eyebrow is supplied", () => {
    render(<PageHeader title="별도 화면" eyebrow="운영" actions={<button>새로고침</button>} />);
    const header = screen.getByRole("heading", { name: "별도 화면" }).closest("header");
    if (!header) throw new Error("Missing page header");
    expect(header).toHaveTextContent("운영 · 미리보기");
    expect(within(header).getByRole("button", { name: "새로고침" })).toBeVisible();
  });

  it("does not restore a globally disabled legacy link", () => {
    runtime.auth = { ...runtime.auth, legacyFallback: false };
    render(routedHeader());
    expect(screen.queryByRole("link", { name: "기존 화면에서 열기" })).not.toBeInTheDocument();
  });
});
