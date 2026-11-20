import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLocation } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { SkillPage } from "./SkillPage";
import { mockApi, apiFailure } from "@/test/api";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";

const runtime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"], referenceSupported: true }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: runtime.scopes });
      return {
        ...auth,
        credentialPrefixes: ["corp_"],
        capabilities: {
          ...auth.capabilities,
          legacy_skill_detail: true,
          legacy_skill_reference_detail: runtime.referenceSupported,
        },
      };
    },
  };
});
const ref = "skl_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const otherRef = "skl_BAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const name = "corp_" + "x".repeat(43);
const selected = {
  name,
  skill_ref: ref,
  description: "선택한 스킬",
  version: "1.0",
  owner: "operator",
  status: "draft",
  risk_level: "low",
  allowed_models: "model",
  allowed_tools: "tool",
  allowed_teams: "team",
  daily_limit: 1,
  instructions: "저장된 지침",
  metadata: '{"private":"keep"}',
  created_at: "2026-11-18T00:00:00Z",
  updated_at: "2026-11-18T00:00:00Z",
  updated_by: "operator",
};
const base = { "GET /admin/skills/stats": () => ({ stats: [] }) };
function Location() {
  return <output data-testid="location">{useLocation().search}</output>;
}
function renderPage(query = "") {
  return renderScreen(
    <>
      <Location />
      <FeatureAccessHarness featureId="agents.skills">
        <SkillPage />
      </FeatureAccessHarness>
    </>,
    { path: "/agents/skills", route: "/agents/skills" + query },
  );
}
beforeEach(() => {
  runtime.scopes = ["admin:read", "admin:write"];
  runtime.referenceSupported = true;
});
it("selects a protected row without putting its name in address or read queries", async () => {
  const user = userEvent.setup();
  const api = mockApi({
    ...base,
    "GET /admin/skills": ({ query }) =>
      (query as { view?: string })?.view === "detail" ? { skill: selected } : { skills: [selected] },
  });
  renderPage();
  const table = await screen.findByRole("table", { name: "스킬 카탈로그" });
  await user.click(within(table).getByRole("button", { name: name + " 상세 열기" }));
  const dialog = await screen.findByRole("dialog", { name });
  expect(screen.getByTestId("location")).toHaveTextContent("?skill_ref=" + ref);
  expect(screen.getByTestId("location")).not.toHaveTextContent(name);
  expect(within(dialog).getByRole("link", { name: "기존 화면에서 열기" })).toHaveAttribute(
    "href",
    "/admin#/skills?skill_ref=" + ref,
  );
  expect(
    api.calls
      .filter((call) => call.key === "GET /admin/skills")
      .some(
        (call) => JSON.stringify(call.options.query) === JSON.stringify({ view: "detail", skill_ref: ref }),
      ),
  ).toBe(true);
  expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
  for (const call of api.calls) expect(JSON.stringify(call.options.query ?? {})).not.toContain(name);
});
it("reads an exact referenced skill independently of status-filtered catalog", async () => {
  mockApi({
    ...base,
    "GET /admin/skills": ({ query }) =>
      (query as { view?: string })?.view === "detail" ? { skill: selected } : { skills: [] },
  });
  renderPage("?skill_ref=" + ref + "&status=production");
  const dialog = await screen.findByRole("dialog", { name });
  expect(within(dialog).getByText("선택한 스킬")).toBeVisible();
  expect(within(dialog).getByRole("link", { name: "기존 화면에서 열기" })).toHaveAttribute(
    "href",
    "/admin#/skills?skill_ref=" + ref,
  );
});
it.each([
  "?skill_ref=" + ref + "&skill=other",
  "?skill_ref=" + ref + "&skill_ref=" + otherRef,
  "?skill_ref=invalid",
])("does not retarget an invalid or ambiguous selection %s", async (query) => {
  const api = mockApi({ ...base, "GET /admin/skills": () => ({ skills: [selected] }) });
  renderPage(query);
  await screen.findByRole("table", { name: "스킬 카탈로그" });
  expect(screen.getByTestId("location").textContent).toBe("");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.calls.some((call) => (call.options.query as { view?: string })?.view === "detail")).toBe(false);
});
it("keeps the requested reference for recovery after a mismatched detail response", async () => {
  mockApi({
    ...base,
    "GET /admin/skills": ({ query }) =>
      (query as { view?: string })?.view === "detail"
        ? { skill: { ...selected, skill_ref: otherRef, description: "WRONG_RESOURCE" } }
        : { skills: [] },
  });
  renderPage("?skill_ref=" + ref);
  const dialog = await screen.findByRole("dialog", { name: "스킬" });
  expect(await within(dialog).findByText("선택한 스킬을 불러오지 못했습니다.")).toBeVisible();
  expect(within(dialog).queryByText("WRONG_RESOURCE")).toBeNull();
  expect(within(dialog).getByRole("link", { name: "기존 화면에서 열기" })).toHaveAttribute(
    "href",
    "/admin#/skills?skill_ref=" + ref,
  );
});
it("retains native exact recovery when the broad catalog fails", async () => {
  mockApi({
    ...base,
    "GET /admin/skills": ({ query }) => {
      if ((query as { view?: string })?.view === "detail") return { skill: selected };
      throw apiFailure("unavailable");
    },
  });
  renderPage("?skill_ref=" + ref);
  await screen.findByRole("alert");
  expect(screen.getByRole("link", { name: "기존 화면에서 열기" })).toHaveAttribute(
    "href",
    "/admin#/skills?skill_ref=" + ref,
  );
});
it("edits imported identity through the reference and leaves metadata for exact preservation", async () => {
  const user = userEvent.setup();
  const api = mockApi({
    ...base,
    "GET /admin/skills": ({ query }) =>
      (query as { view?: string })?.view === "detail" ? { skill: selected } : { skills: [selected] },
    "POST /admin/skills": () => ({ skill: selected }),
  });
  renderPage("?skill_ref=" + ref);
  const detail = await screen.findByRole("dialog", { name });
  await user.click(within(detail).getByRole("button", { name: "편집" }));
  const editor = await screen.findByRole("dialog", { name: "스킬 수정 · " + name });
  expect(within(editor).getByRole("textbox", { name: /^이름/u })).toHaveValue(name);
  const description = within(editor).getByRole("textbox", { name: "설명" });
  await user.clear(description);
  await user.type(description, "수정된 설명");
  await user.click(within(editor).getByRole("button", { name: "수정 저장" }));
  await waitFor(() => expect(api.bodies("POST /admin/skills")).toHaveLength(1));
  expect(api.bodies("POST /admin/skills")[0]).toMatchObject({
    skill_ref: ref,
    name,
    description: "수정된 설명",
  });
  expect(api.bodies("POST /admin/skills")[0]).not.toHaveProperty("metadata");
});
it("deletes only the chosen reference after confirmation", async () => {
  const user = userEvent.setup();
  let removed = false;
  const api = mockApi({
    ...base,
    "GET /admin/skills": ({ query }) =>
      (query as { view?: string })?.view === "detail"
        ? { skill: removed ? null : selected }
        : { skills: removed ? [] : [selected] },
    "DELETE /admin/skills": () => {
      removed = true;
      return { skill_ref: ref, deleted: true };
    },
  });
  renderPage("?skill_ref=" + ref);
  const detail = await screen.findByRole("dialog", { name });
  await user.click(within(detail).getByRole("button", { name: "삭제" }));
  const confirmation = await screen.findByRole("dialog", { name: "스킬 삭제" });
  expect(api.calls.some((call) => call.key.startsWith("DELETE"))).toBe(false);
  await user.click(within(confirmation).getByRole("button", { name: "삭제" }));
  await waitFor(() =>
    expect(api.calls.filter((call) => call.key === "DELETE /admin/skills")).toHaveLength(1),
  );
  expect(api.calls.find((call) => call.key === "DELETE /admin/skills")?.options.query).toEqual({
    skill_ref: ref,
  });
  expect(api.calls.some((call) => call.key.includes("/by-name/"))).toBe(false);
  await waitFor(() => expect(screen.getByTestId("location").textContent).toBe(""));
});
it("keeps reference-selected writes disabled for readonly users", async () => {
  runtime.scopes = ["admin:read"];
  const api = mockApi({
    ...base,
    "GET /admin/skills": ({ query }) =>
      (query as { view?: string })?.view === "detail" ? { skill: selected } : { skills: [selected] },
  });
  renderPage("?skill_ref=" + ref);
  const detail = await screen.findByRole("dialog", { name });
  for (const action of ["편집", "삭제", "승격"])
    expect(within(detail).getByRole("button", { name: action })).toBeDisabled();
  expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
});
