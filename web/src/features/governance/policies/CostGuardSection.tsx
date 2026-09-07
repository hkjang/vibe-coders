import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { z } from "zod";

import { PanelFailure } from "@/features/governance/policies/governance-parts";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Switch } from "@/shared/components/ui/Switch";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatKRW } from "@/shared/utils/format";

const routeId = "governance.policies";

const costGuardFormSchema = z.object({
  enabled: z.boolean(),
  thresholdKrw: z.coerce.number().min(0, "임계값은 0 이상이어야 합니다."),
});
type CostGuardFormValues = z.output<typeof costGuardFormSchema>;
type CostGuardFormInput = z.input<typeof costGuardFormSchema>;

/**
 * Pre-call cost guard (legacy `#/safety`): blocks a request whose predicted cost
 * exceeds the per-request limit. Spend reporting itself lives in FinOps.
 */
export function CostGuardSection({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const guard = useQuery({
    queryKey: ["governance", "cost-guard"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.governance.costGuard.get, { signal, routeId }),
  });

  const form = useZodForm<CostGuardFormInput, CostGuardFormValues>(costGuardFormSchema, {
    enabled: false,
    thresholdKrw: 0,
  });

  const { reset } = form;
  const loaded = guard.data;
  useEffect(() => {
    if (loaded) reset({ enabled: loaded.enabled === true, thresholdKrw: Number(loaded.threshold_krw ?? 0) });
  }, [loaded, reset]);

  const saveGuard = useMutationFeedback({
    mutate: (values: CostGuardFormValues) =>
      apiClient.request(endpoints.domains.governance.costGuard.save, {
        body: { enabled: values.enabled, threshold_krw: values.thresholdKrw },
        routeId,
      }),
    invalidates: [["governance", "cost-guard"]],
    successMessage: "비용 가드를 저장했습니다.",
    errorMessage: "비용 가드를 저장하지 못했습니다.",
  });

  const enabled = form.watch("enabled");

  return (
    <SectionCard
      title="비용 가드"
      description="호출 전 예상 비용이 한도를 넘으면 요청을 차단합니다. 지출 분석과 예산은 FinOps 화면에서 봅니다."
      actions={
        guard.data?.enabled ? (
          <Badge tone="success">{`사용 중 · 요청당 ${formatKRW(guard.data.threshold_krw)}`}</Badge>
        ) : (
          <Badge tone="muted">중지</Badge>
        )
      }
    >
      {guard.isError ? (
        <PanelFailure
          error={guard.error}
          hasData={Boolean(guard.data)}
          label="비용 가드 설정"
          onRetry={() => void guard.refetch()}
        />
      ) : null}
      <form
        className="governance-actions"
        onSubmit={form.handleSubmit(async (values) => {
          await saveGuard.mutateAsync(values);
        })}
      >
        <Switch
          checked={enabled}
          disabled={!canWrite}
          title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
          label="비용 가드 사용"
          onCheckedChange={(checked) => form.setValue("enabled", checked, { shouldDirty: true })}
        />
        <FormField
          label="요청당 임계값 (KRW)"
          description="0이면 제한하지 않습니다."
          error={form.formState.errors.thresholdKrw?.message}
        >
          {(control) => (
            <Input
              {...control}
              type="number"
              min={0}
              step="1"
              disabled={!canWrite}
              {...form.register("thresholdKrw")}
            />
          )}
        </FormField>
        <Button
          type="submit"
          variant="primary"
          disabled={!canWrite || saveGuard.isPending}
          title={canWrite ? undefined : "admin:write 권한이 필요합니다."}
        >
          비용 가드 저장
        </Button>
      </form>
    </SectionCard>
  );
}
