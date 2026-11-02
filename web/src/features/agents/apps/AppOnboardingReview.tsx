import { useMutation } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { z } from "zod";
import { useAppOperationAccess } from "./app-scope";
import { appOnboardingBody, type AppFormInput, type AppFormOutput } from "./app-form";
import { OnboardingChecklist } from "./OnboardingChecklist";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

const required = ["title", "owner", "components"];
const responseSchema = z
  .object({
    ready: z.boolean(),
    missing: z.number().int().nonnegative(),
    checks: z
      .array(
        z.object({
          key: z.string().min(1),
          ok: z.boolean(),
          severity: z.enum(["required", "recommended"]),
          detail: z.string(),
        }),
      )
      .min(3),
  })
  .refine(
    (value) =>
      new Set(value.checks.map((c) => c.key)).size === value.checks.length &&
      required.every((key) => value.checks.some((c) => c.key === key && c.severity === "required")) &&
      value.ready === value.checks.filter((c) => c.severity === "required").every((c) => c.ok) &&
      value.missing === value.checks.filter((c) => !c.ok).length,
  );

export function AppOnboardingReview({
  form,
  owner,
}: {
  form: UseFormReturn<AppFormInput, unknown, AppFormOutput>;
  owner: string;
}) {
  const access = useAppOperationAccess();
  const revision = useRef(0);
  const requested = useRef(false);
  const [stale, setStale] = useState(false);
  const onboarding = useMutation({
    gcTime: 0,
    retry: false,
    mutationFn: async ({ values, generation }: { values: AppFormOutput; generation: number }) => {
      access.assertCurrent();
      const result = await apiClient.request(endpoints.domains.agents.apps.onboardingCheck, {
        body: appOnboardingBody(values, owner),
        routeId: "agents.apps",
        retryUnauthorized: false,
      });
      access.assertCurrent();
      if (generation !== revision.current)
        throw new AppError("점검 이후 입력이 변경되었습니다.", { kind: "aborted" });
      const parsed = responseSchema.safeParse(result);
      if (!parsed.success)
        throw new AppError("준비도 응답의 항목과 요약을 확인할 수 없습니다.", { kind: "contract" });
      return parsed.data;
    },
  });
  const { reset } = onboarding;
  useEffect(() => {
    const subscription = form.watch(() => {
      revision.current++;
      if (requested.current) setStale(true);
      reset();
    });
    return () => subscription.unsubscribe();
  }, [form, reset]);
  return (
    <section aria-label="업무 앱 준비도 점검" className="agents-detail-stack">
      <p>
        제목·책임자·구성 요소 등 등록 준비 상태만 점검합니다. 실제 실행, 참조 존재, 접근 권한 또는 비용을
        검증하지 않습니다.
      </p>
      <Button
        size="small"
        disabled={onboarding.isPending || !access.allowed}
        onClick={() => {
          const generation = revision.current;
          void form.handleSubmit((values) => {
            if (generation !== revision.current) return;
            requested.current = true;
            setStale(false);
            onboarding.mutate({ values, generation });
          })();
        }}
      >
        {onboarding.isPending ? "확인 중" : "온보딩 준비도 확인"}
      </Button>
      {stale ? <p role="status">입력이 변경되었습니다. 준비도를 다시 확인하세요.</p> : null}
      {onboarding.isError && !stale ? (
        <InlineNotice tone="danger" title="준비도를 확인하지 못했습니다.">
          {safeAppErrorMessage(onboarding.error, "준비도를 확인하지 못했습니다.")}
        </InlineNotice>
      ) : null}
      {onboarding.data && !stale && access.allowed ? (
        <>
          <InlineNotice tone={onboarding.data.ready ? "success" : "warning"}>
            {onboarding.data.ready
              ? "점검 당시 필수 준비 항목을 충족했습니다. 실제 발행 시 서버가 다시 확인합니다."
              : "필수 준비 항목이 충족되지 않았습니다."}
          </InlineNotice>
          <OnboardingChecklist checks={onboarding.data.checks} label="온보딩 준비도 점검 결과" />
        </>
      ) : null}
    </section>
  );
}
