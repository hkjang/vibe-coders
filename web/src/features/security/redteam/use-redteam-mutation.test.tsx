import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it, vi } from "vitest";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import type { FeatureAccess } from "@/shared/feature-access/policy";
import { useRedTeamMutation } from "./use-redteam-mutation";

const writable: FeatureAccess = { featureId: "security.redteam", permitted: true, readOnly: false };

for (const [label, access, allowed] of [
  ["읽기 전용", { ...writable, readOnly: true }, true],
  ["다른 화면", { ...writable, featureId: "agents.skills" }, true],
  ["화면 거부", { ...writable, permitted: false }, true],
  ["설정 없음", undefined, true],
  ["쓰기 권한 없음", writable, false],
] as const) {
  it(`${label}: 저장 콜백을 직접 실행해도 요청과 성공 처리가 없다`, async () => {
    const client = new QueryClient();
    const request = vi.fn(async () => ({ ok: true })),
      success = vi.fn();
    const view = renderHook(
      () => useRedTeamMutation(allowed, { observation: "save", mutate: request, onSuccess: success }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>
            <FeatureAccessContext.Provider value={access}>{children}</FeatureAccessContext.Provider>
          </QueryClientProvider>
        ),
      },
    );
    await act(async () => {
      await expect(view.result.current.mutateAsync(undefined)).rejects.toMatchObject({ kind: "aborted" });
    });
    expect(request).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
    view.unmount();
    client.clear();
  });
}

it("이미 전송한 변경의 늦은 응답은 화면 종료 뒤 성공 알림과 캐시 무효화를 하지 않는다", async () => {
  const client = new QueryClient();
  let resolve!: (value: { ok: boolean }) => void;
  const pending = new Promise<{ ok: boolean }>((done) => {
    resolve = done;
  });
  const request = vi.fn(() => pending),
    success = vi.fn();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = renderHook(
    () =>
      useRedTeamMutation(true, {
        observation: "save",
        mutate: request,
        onSuccess: success,
        invalidates: [["redteam"]],
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>
          <FeatureAccessContext.Provider value={writable}>{children}</FeatureAccessContext.Provider>
        </QueryClientProvider>
      ),
    },
  );
  let submission!: Promise<unknown>;
  await act(async () => {
    submission = view.result.current.mutateAsync(undefined);
    await Promise.resolve();
  });
  expect(request).toHaveBeenCalledTimes(1);
  view.unmount();
  await act(async () => {
    resolve({ ok: true });
    await expect(submission).rejects.toMatchObject({ kind: "aborted" });
  });
  expect(success).not.toHaveBeenCalled();
  expect(invalidate).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
  client.clear();
});
