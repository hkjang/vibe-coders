import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext, useEffect, useState } from "react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { z } from "zod";

import { useAuth } from "@/app/auth/AuthProvider";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { ModelTagPanel } from "./ModelTagPanel";
import type { ModelUsageTag } from "@/shared/api/schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ mode: "writable", scopes: ["admin:read", "admin:write"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: runtime.scopes });
      return {
        ...auth,
        features: auth.features.map((feature) =>
          feature.featureId === "gateway.chat"
            ? {
                ...feature,
                status: runtime.mode === "preview_read_only" ? "preview_read_only" : "preview",
                readOnly: runtime.mode === "read_only",
              }
            : feature,
        ),
      };
    },
  };
});
const modelTagToasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
export function getModelTagToasts() {
  return modelTagToasts;
}
vi.mock("sonner", () => ({ toast: modelTagToasts }));

export const savePath = "POST /admin/model-tags";
export const modelA = "public-model-a";
export const modelB = "public-model-b";
const timestamp = "2026-09-30T01:00:00Z";
const bodySchema = z.object({
  model: z.string(),
  good_for: z.string(),
  avoid_for: z.string(),
  risk_note: z.string(),
});
export function row(model: string, goodFor: string): ModelUsageTag {
  return {
    model,
    good_for: goodFor,
    avoid_for: "public-avoid",
    risk_note: "public-risk",
    updated_by: "public-original-actor",
    updated_at: timestamp,
  };
}

beforeEach(() => {
  runtime.mode = "writable";
  runtime.scopes = ["admin:read", "admin:write"];
  tokenStore.clearAll();
});
afterEach(() => vi.restoreAllMocks());

export async function setup(seed = [row(modelA, "original-a"), row(modelB, "original-b")]) {
  function AccessProbe() {
    const access = useContext(FeatureAccessContext);
    return <output data-testid="model-tag-feature-readonly">{String(access?.readOnly)}</output>;
  }
  const records = new Map(seed.map((item) => [item.model, { ...item }]));
  const response: { read?: () => unknown; save?: () => unknown } = {};
  // Actual React/API callback boundary, not a Go authorization or database test.
  // This synthetic endpoint deliberately does not reject readonly or scope loss.
  // The Go HTTP contract separately proves TrimSpace + same-model full upsert.
  const api = mockApi({
    "GET /admin/model-tags": () =>
      response.read ? response.read() : { tags: [...records.values()].map((item) => ({ ...item })) },
    [savePath]: ({ body }) => {
      const values = bodySchema.parse(body);
      const model = values.model.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
      const saved = { ...values, model, updated_by: "public-current-actor", updated_at: timestamp };
      records.set(model, saved);
      return response.save ? response.save() : { ...saved };
    },
    ...Object.fromEntries(
      seed.map((item) => [
        `DELETE /admin/model-tags/${encodeURIComponent(item.model)}`,
        () => {
          records.delete(item.model);
          return { status: "deleted" };
        },
      ]),
    ),
  });
  const feature = migrationRegistry.find((candidate) => candidate.featureId === "gateway.chat");
  if (!feature) throw new Error("missing actual gateway.chat migration entry");
  const chatFeature = feature;
  let rerender: () => void = () => undefined;
  function Host() {
    const [, setRevision] = useState(0);
    const auth = useAuth();
    useEffect(() => {
      rerender = () => setRevision((revision) => revision + 1);
      return () => {
        rerender = () => undefined;
      };
    }, []);
    return (
      <FeatureRoute feature={chatFeature}>
        <AccessProbe />
        <ModelTagPanel
          canWrite={auth.user?.scopes.includes("admin:write") === true}
          writeDeniedReason="admin:write 권한이 필요합니다."
        />
      </FeatureRoute>
    );
  }
  const view = renderScreen(<Host />, { path: "/gateway/chat", route: "/gateway/chat?tab=tags" });
  if (seed.length) await screen.findByRole("table", { name: "모델별 용도 태그" });
  else await screen.findByText("등록된 용도 태그가 없습니다.");
  expect(screen.getByTestId("model-tag-feature-readonly")).toHaveTextContent("false");
  return {
    api,
    response,
    records,
    view,
    user: userEvent.setup(),
    update(mode: string, write = true) {
      act(() => {
        runtime.mode = mode;
        runtime.scopes = write ? ["admin:read", "admin:write"] : ["admin:read"];
        rerender();
      });
      expect(screen.getByTestId("model-tag-feature-readonly")).toHaveTextContent(String(mode !== "writable"));
    },
    scopes(scopes: string[]) {
      act(() => {
        runtime.scopes = scopes;
        rerender();
      });
    },
  };
}

export async function edit(view: Awaited<ReturnType<typeof setup>>, currentGuidance = "original-a") {
  const cell = screen.getByRole("cell", { name: currentGuidance });
  const tableRow = cell.closest("tr");
  if (!tableRow) throw new Error("missing actual tag row");
  await view.user.click(within(tableRow).getByRole("button", { name: "수정" }));
  const dialog = screen.getByRole("dialog", { name: "모델 용도 태그" });
  const guidance = within(dialog).getByRole("textbox", { name: "적합한 작업" });
  await view.user.clear(guidance);
  await view.user.type(guidance, "revised-a");
  return dialog;
}

export async function nativeSubmit(dialog: HTMLElement) {
  const form = dialog.querySelector("form");
  if (!form) throw new Error("missing actual FormDialog form");
  const listener = vi.fn();
  form.addEventListener("submit", listener);
  await act(async () => {
    form.requestSubmit();
  });
  expect(listener).toHaveBeenCalledTimes(1);
  form.removeEventListener("submit", listener);
}

export async function review(current: Awaited<ReturnType<typeof setup>>, dialog: HTMLElement) {
  await current.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
  await current.user.click(
    await within(dialog).findByRole("checkbox", { name: "대상과 변경 내용을 확인했습니다." }),
  );
  expect(within(dialog).getByRole("button", { name: "검토한 태그 저장" })).toBeEnabled();
}
