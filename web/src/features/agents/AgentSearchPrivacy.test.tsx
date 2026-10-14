import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppPage } from "./apps/AppPage";
import { WorkflowPage } from "./workflows/WorkflowPage";
import { SkillPage } from "./skills/SkillPage";
import { mockApi } from "@/test/api";
import { FeatureAccessHarness } from "@/test/feature-access";
import { renderScreen } from "@/test/render";
import type * as SearchState from "@/shared/hooks/use-search-state";

const runtime = vi.hoisted(() => ({ prefixes: ["corp_"], updates: vi.fn() }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => ({ ...testAuth(), credentialPrefixes: runtime.prefixes }) };
});
vi.mock("@/shared/hooks/use-search-state", async (importOriginal) => {
  const original = await importOriginal<typeof SearchState>();
  return {
    ...original,
    useSearchState: () => {
      const [params, update] = original.useSearchState();
      return [
        params,
        (...args: Parameters<typeof update>) => {
          runtime.updates(...args);
          update(...args);
        },
      ] as const;
    },
  };
});
beforeEach(() => {
  runtime.prefixes = ["corp_"];
  runtime.updates.mockClear();
});
const screens = [
  { id: "apps", label: "업무 앱 검색", page: AppPage },
  { id: "workflows", label: "워크플로 검색", page: WorkflowPage },
  { id: "skills", label: "스킬 검색", page: SkillPage },
] as const;
describe.each(screens)("$id 검색 개인정보 경계", ({ id, label, page: Page }) => {
  function setup() {
    mockApi({
      "GET /admin/apps": () => ({ apps: [] }),
      "GET /admin/workflows": () => ({ workflows: [] }),
      "GET /admin/skills": () => ({ skills: [] }),
      "GET /admin/skills/stats": () => ({ stats: [] }),
    });
    renderScreen(
      <FeatureAccessHarness featureId={`agents.${id}`}>
        <Page />
      </FeatureAccessHarness>,
      { path: `/agents/${id}`, route: `/agents/${id}` },
    );
  }
  it.each(["corp_", "%41_"])("%s 접두사 원문과 인코딩 검색을 URL 함수에 넘기지 않는다", async (prefix) => {
    runtime.prefixes = [prefix];
    setup();
    const input = await screen.findByLabelText(label);
    const form = input.closest("form");
    if (!form) throw new Error("Missing search form");
    const secret = `${prefix}${"A".repeat(32)}`;
    for (const value of [
      secret,
      encodeURIComponent(secret),
      encodeURIComponent(encodeURIComponent(secret)),
    ]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.submit(form);
      expect(screen.getByRole("alert")).toHaveTextContent("주소에 저장하지 않습니다");
      expect(input).toHaveFocus();
      expect(input).toHaveValue(value);
      expect(runtime.updates).not.toHaveBeenCalled();
    }
    fireEvent.change(input, { target: { value: "분기 보고" } });
    fireEvent.submit(form);
    expect(runtime.updates).toHaveBeenCalledWith({ q: "분기 보고" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
