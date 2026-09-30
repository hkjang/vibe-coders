import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RequestInsightPanel } from "./RequestInsightPanel";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import type * as MutationFeedbackModule from "@/shared/hooks/use-mutation-feedback";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ readOnly: false, raw: true }));
const mutations = vi.hoisted(() => new Map<string, (value: unknown) => Promise<unknown>>());
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ rawPromptView: runtime.raw });
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
      mutations.set(options.errorMessage ?? "", options.mutate);
      return real.useMutationFeedback(options);
    },
  };
});
beforeEach(() => {
  runtime.readOnly = false;
  runtime.raw = true;
  mutations.clear();
});
describe("실제 provider 실행 경계", () => {
  it.each(["observability.llm", "observability.xview"])(
    "%s의 analyze/replay 실제 callback은 최신 readonly·기존 원문 권한을 모두 검사한다",
    async (id) => {
      const api = mockApi({
        "GET /admin/requests/req/note": () => ({
          request_id: "req",
          note: "",
          tags: [],
          exists: false,
          redacted_fields: [],
          created_by: "",
          updated_at: "",
        }),
        "GET /admin/requests/req/explain": () => new Promise(() => undefined),
        "GET /admin/requests/req/trace": () => new Promise(() => undefined),
        "GET /admin/requests/req/links": () => new Promise(() => undefined),
        "POST /admin/requests/req/analyze": () => ({ analysis: "공개 분석 결과" }),
        "POST /admin/requests/req/replay": () => ({ result: "공개 재실행 결과" }),
      });
      let refresh: () => void = () => undefined;
      const selected = migrationRegistry.find((entry) => entry.featureId === id);
      if (!selected) throw new Error("missing fixture feature");
      const feature = selected;
      function Host() {
        const [, redraw] = useState(0);
        refresh = () => redraw((value) => value + 1);
        return (
          <FeatureRoute feature={feature}>
            <RequestInsightPanel requestId="req" canInspectRaw canWriteNote />
          </FeatureRoute>
        );
      }
      renderScreen(<Host />);
      const analyze = mutations.get("요청 분석을 실행하지 못했습니다."),
        replay = mutations.get("요청을 재실행하지 못했습니다.");
      if (!analyze || !replay) throw new Error("missing real execution callback");
      runtime.readOnly = true;
      act(refresh);
      expect(screen.getByRole("button", { name: "분석 실행" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "재실행" })).toBeDisabled();
      await expect(Promise.resolve().then(() => analyze(undefined))).rejects.toMatchObject({
        kind: "permission",
      });
      await expect(Promise.resolve().then(() => replay(undefined))).rejects.toMatchObject({
        kind: "permission",
      });
      runtime.readOnly = false;
      runtime.raw = false;
      act(refresh);
      await expect(Promise.resolve().then(() => analyze(undefined))).rejects.toMatchObject({
        kind: "permission",
      });
      await expect(Promise.resolve().then(() => replay(undefined))).rejects.toMatchObject({
        kind: "permission",
      });
      expect(api.bodies("POST /admin/requests/req/analyze")).toEqual([]);
      expect(api.bodies("POST /admin/requests/req/replay")).toEqual([]);
      runtime.raw = true;
      act(refresh);
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: "분석 실행" }));
      await waitFor(() => expect(api.bodies("POST /admin/requests/req/analyze")).toHaveLength(1));
      await replay(undefined);
      expect(api.bodies("POST /admin/requests/req/replay")).toHaveLength(1);
    },
  );
});
