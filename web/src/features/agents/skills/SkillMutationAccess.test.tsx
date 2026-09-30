import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SkillPage } from "./SkillPage";
import { skillFormDefaults, skillFormSchema } from "./skill-form";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { tokenStore } from "@/shared/auth/token-store";
import type * as MutationFeedbackModule from "@/shared/hooks/use-mutation-feedback";
import type * as ConfirmDialogModule from "@/shared/components/ui/ConfirmDialog";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ readOnly: false }));
const callbacks = vi.hoisted(() => ({
  mutations: new Map<string, (value: unknown) => Promise<unknown>>(),
  confirms: new Map<string, (reason: string) => unknown>(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth();
      return {
        ...auth,
        features: auth.features.map((feature) => ({ ...feature, readOnly: runtime.readOnly })),
      };
    },
  };
});
vi.mock("@/shared/hooks/use-mutation-feedback", async (load) => {
  const real = await load<typeof MutationFeedbackModule>();
  return {
    useMutationFeedback: (options: Parameters<typeof real.useMutationFeedback>[0]) => {
      callbacks.mutations.set(options.errorMessage ?? "", options.mutate);
      return real.useMutationFeedback(options);
    },
  };
});
vi.mock("@/shared/components/ui/ConfirmDialog", async (load) => {
  const real = await load<typeof ConfirmDialogModule>();
  return {
    ConfirmDialog: (props: ComponentProps<typeof real.ConfirmDialog>) => {
      callbacks.confirms.set(props.title, props.onConfirm);
      return <real.ConfirmDialog {...props} />;
    },
  };
});
const skill = { name: "skill", status: "staging", instructions: "검토 지침", description: "설명" };
async function setup() {
  const api = mockApi({
    "GET /admin/skills": () => ({ skills: [skill] }),
    "GET /admin/skills/stats": () => ({ stats: [] }),
    "POST /admin/skills": () => ({ skill }),
    "POST /admin/skills/promote": () => ({ skill }),
    "DELETE /admin/skills/by-name/skill": () => ({ ok: true }),
    "POST /admin/skill-studio/adopt": () => ({ skill }),
    "POST /admin/skills/import": () => ({ imported: ["skill"] }),
    "POST /admin/skills/seed-recommended": () => ({ seeded: [] }),
    "POST /admin/skills/recommend": () => ({ recommendations: [], applied: false, count: 0 }),
    "POST /admin/skills/evaluate": () => ({
      allowed: true,
      violations: [],
      would_block: false,
      enforcement: "off",
    }),
    "GET /admin/skill-studio/candidates": () => ({
      candidates: [
        {
          id: "candidate",
          title: "합성 후보",
          source: "fixture",
          suggested_name: "candidate",
          suggested: { instructions: "공개 지침" },
        },
      ],
    }),
  });
  const selected = migrationRegistry.find((entry) => entry.featureId === "agents.skills");
  if (!selected) throw new Error("missing fixture feature");
  const feature = selected;
  let refresh: () => void = () => undefined;
  function Host() {
    const [, redraw] = useState(0);
    refresh = () => redraw((value) => value + 1);
    return (
      <FeatureRoute feature={feature}>
        <SkillPage />
      </FeatureRoute>
    );
  }
  renderScreen(<Host />, { route: "/agents/skills" });
  await screen.findByRole("button", { name: "skill 상세 열기" });
  return {
    api,
    user: userEvent.setup(),
    readonly: (value: boolean) => {
      runtime.readOnly = value;
      act(refresh);
    },
  };
}
beforeEach(() => {
  runtime.readOnly = false;
  tokenStore.clearAll();
  callbacks.mutations.clear();
  callbacks.confirms.clear();
  toast.error.mockClear();
  toast.success.mockClear();
});
describe("Skills 실제 요청 직전 readonly 경계", () => {
  it.each([
    [
      "스킬을 저장하지 못했습니다.",
      "POST /admin/skills",
      (): unknown => skillFormSchema.parse(skillFormDefaults(skill)),
    ],
    [
      "스킬을 승격하지 못했습니다.",
      "POST /admin/skills/promote",
      (): unknown => ({ name: "skill", to_status: "production", note: "확인" }),
    ],
    ["스킬을 삭제하지 못했습니다.", "DELETE /admin/skills/by-name/skill", (): unknown => "skill"],
    [
      "후보를 채택하지 못했습니다.",
      "POST /admin/skill-studio/adopt",
      (): unknown => ({ name: "skill", source: "fixture", instructions: "지침" }),
    ],
    [
      "스킬 번들을 가져오지 못했습니다.",
      "POST /admin/skills/import",
      (): unknown => ({ version: "1", skills: [skill] }),
    ],
    ["추천 스킬을 추가하지 못했습니다.", "POST /admin/skills/seed-recommended", (): unknown => undefined],
  ] as const)("%s 캡처된 mutation도 최신 설정을 확인한다", async (key, endpoint, values) => {
    const current = await setup();
    const captured = callbacks.mutations.get(key);
    if (!captured) throw new Error(`missing real mutation ${key}`);
    current.readonly(true);
    await expect(Promise.resolve().then(() => captured(values()))).rejects.toMatchObject({
      kind: "permission",
    });
    expect(current.api.bodies(endpoint)).toEqual([]);
    current.readonly(false);
    expect(current.api.bodies(endpoint)).toEqual([]);
    await captured(values());
    expect(current.api.bodies(endpoint)).toHaveLength(1);
  });
  it("recommend apply=true의 실제 확인 callback은 차단하고 복구 후 수동1회만 적용한다", async () => {
    const current = await setup();
    const captured = callbacks.confirms.get("추천을 초안으로 적용");
    if (!captured) throw new Error("missing real apply callback");
    current.readonly(true);
    await expect(captured("")).rejects.toMatchObject({ kind: "permission" });
    expect(current.api.bodies("POST /admin/skills/recommend")).toEqual([]);
    current.readonly(false);
    await captured("");
    expect(current.api.calls.filter((call) => call.key === "POST /admin/skills/recommend")).toMatchObject([
      { options: { query: { apply: "1" } } },
    ]);
  });
  it.each(["create", "adopt"])(
    "%s 열린 폼의 입력과 dirty guard는 readonly 전환에도 유지된다",
    async (kind) => {
      const current = await setup();
      if (kind === "create") await current.user.click(screen.getByRole("button", { name: "스킬 추가" }));
      else {
        await current.user.click(screen.getByRole("tab", { name: "스튜디오" }));
        await current.user.click(await screen.findByRole("button", { name: "합성 후보 채택하기" }));
      }
      const dialog = await screen.findByRole("dialog", {
        name: kind === "create" ? "스킬 추가" : "후보를 스킬로 채택",
      });
      const name = within(dialog).getByRole("textbox", { name: "이름" });
      await current.user.clear(name);
      await current.user.type(name, "kept-draft");
      const endpoint = kind === "create" ? "POST /admin/skills" : "POST /admin/skill-studio/adopt";
      const save = within(dialog).getByRole("button", {
        name: kind === "create" ? "스킬 만들기" : "초안으로 채택",
      });
      current.readonly(true);
      expect(name).toHaveValue("kept-draft");
      expect(name).toBeDisabled();
      expect(save).toBeDisabled();
      const form = dialog.querySelector("form");
      if (!form) throw new Error("missing real editor form");
      fireEvent.submit(form);
      expect(current.api.bodies(endpoint)).toEqual([]);
      await current.user.click(within(dialog).getByRole("button", { name: "취소" }));
      await current.user.click(await screen.findByRole("button", { name: "계속 편집" }));
      expect(name).toHaveValue("kept-draft");
      current.readonly(false);
      expect(current.api.bodies(endpoint)).toEqual([]);
      await current.user.click(save);
      await waitFor(() => expect(current.api.bodies(endpoint)).toHaveLength(1));
    },
  );
  it("비동기 파일 읽기 동안 readonly로 바뀌면 파싱이 끝나도 import POST가 없다", async () => {
    const current = await setup();
    let release!: (text: string) => void;
    const file = new File(["public fixture"], "skills.json", { type: "application/json" });
    const read = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    Object.defineProperty(file, "text", { value: read });
    await current.user.upload(screen.getByLabelText("가져오기"), file);
    expect(read).toHaveBeenCalledTimes(1);
    current.readonly(true);
    await act(async () => release(JSON.stringify({ version: "1", skills: [skill] })));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(current.api.bodies("POST /admin/skills/import")).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith("이 작업을 수행할 권한이 없습니다.");
  });
  it("runtime readonly에서도 순수 POST 추천조회·정책계산은 기존 권한으로 유지한다", async () => {
    runtime.readOnly = true;
    const current = await setup();
    expect(screen.getByRole("button", { name: "보안 스캔" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "내보내기" })).toBeEnabled();
    await current.user.click(screen.getByRole("button", { name: "스킬 추천" }));
    await waitFor(() => expect(current.api.bodies("POST /admin/skills/recommend")).toHaveLength(1));
    expect(
      current.api.calls.find((call) => call.key === "POST /admin/skills/recommend")?.options.query,
    ).not.toHaveProperty("apply");
    await current.user.click(screen.getByRole("button", { name: "skill 상세 열기" }));
    await current.user.click(screen.getByRole("button", { name: "정책 시뮬레이션" }));
    await current.user.click(screen.getByRole("button", { name: "정책 확인" }));
    await waitFor(() => expect(current.api.bodies("POST /admin/skills/evaluate")).toHaveLength(1));
  });
  it.each([false, true])(
    "파일 읽기 중 새 세션이 되면 이전 파일의 전송·알림을 막는다: failure=%s",
    async (failure) => {
      const current = await setup();
      let release!: () => void;
      const file = new File(["public fixture"], "skills.json", { type: "application/json" });
      Object.defineProperty(file, "text", {
        value: () =>
          new Promise<string>((resolve, reject) => {
            release = () =>
              failure
                ? reject(new Error("synthetic read failure"))
                : resolve(JSON.stringify({ version: "1", skills: [skill] }));
          }),
      });
      await current.user.upload(screen.getByLabelText("가져오기"), file);
      act(() => {
        tokenStore.clearAll();
        tokenStore.saveTokens({
          access_token: "synthetic-next-session",
          refresh_token: "synthetic-next-refresh",
        });
      });
      await act(async () => release());
      expect(current.api.bodies("POST /admin/skills/import")).toEqual([]);
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    },
  );
});
