import { useMutation } from "@tanstack/react-query";
import { useEffect, type RefObject } from "react";

import {
  appComponentsExample,
  appFormDefaults,
  appFormSchema,
  appOnboardingBody,
  appStatusOptions,
  type AppFormInput,
  type AppFormOutput,
} from "@/features/agents/apps/app-form";
import { OnboardingChecklist } from "@/features/agents/apps/OnboardingChecklist";
import { apiClient } from "@/shared/api/client";
import type { WorkApp } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

interface AppFormDialogProps {
  app?: WorkApp;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: AppFormOutput) => Promise<unknown>;
  open: boolean;
  owner: string;
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function AppFormDialog({
  app,
  onOpenChange,
  onSubmit,
  open,
  owner,
  returnFocusRef,
}: AppFormDialogProps): React.JSX.Element {
  const form = useZodForm<AppFormInput, AppFormOutput>(appFormSchema, appFormDefaults(app));
  const { reset } = form;
  useEffect(() => {
    if (open) reset(appFormDefaults(app));
  }, [app, open, reset]);
  const errors = form.formState.errors;

  const onboarding = useMutation({
    mutationFn: (values: AppFormOutput) =>
      apiClient.request(endpoints.domains.agents.apps.onboardingCheck, {
        body: appOnboardingBody(values, app?.owner ?? owner),
        routeId: "agents.apps",
      }),
  });

  return (
    <FormDialog
      description="AI 업무 앱의 기본 정보와 구성 요소(JSON)를 입력합니다. 발행 전에 온보딩 준비도를 확인할 수 있습니다."
      form={form}
      onOpenChange={(next) => {
        if (!next) onboarding.reset();
        onOpenChange(next);
      }}
      onSubmit={onSubmit}
      open={open}
      returnFocusRef={returnFocusRef}
      submitLabel={app ? "수정 저장" : "앱 만들기"}
      title={app ? "AI 업무 앱 수정" : "새 AI 업무 앱"}
    >
      <FormField label="제목" required error={errors.title?.message}>
        {(control) => <Input {...control} {...form.register("title")} />}
      </FormField>
      <FormField label="아이콘" description="이모지 한 글자를 권장합니다." error={errors.icon?.message}>
        {(control) => <Input {...control} {...form.register("icon")} />}
      </FormField>
      <FormField label="설명" error={errors.description?.message}>
        {(control) => <Textarea {...control} rows={2} {...form.register("description")} />}
      </FormField>
      <FormField
        label="허용 팀"
        description="쉼표로 구분합니다. 비워 두면 모든 팀에 노출됩니다."
        error={errors.allowed_teams?.message}
      >
        {(control) => <Input {...control} {...form.register("allowed_teams")} />}
      </FormField>
      <FormField
        label="허용 역할"
        description="쉼표로 구분합니다. 비워 두면 모든 역할에 노출됩니다."
        error={errors.allowed_roles?.message}
      >
        {(control) => <Input {...control} {...form.register("allowed_roles")} />}
      </FormField>
      <FormField label="상태" error={errors.status?.message}>
        {(control) => <Select {...control} options={appStatusOptions} {...form.register("status")} />}
      </FormField>
      <FormField
        label="구성 요소 (JSON 배열)"
        description="각 요소는 kind와 ref, label을 가집니다. kind: skill, prompt_product, text2sql_report, mcp_tool, model"
        required
        error={errors.components?.message}
      >
        {(control) => <Textarea {...control} rows={10} className="mono" {...form.register("components")} />}
      </FormField>
      <div className="agents-detail-actions">
        <Button
          size="small"
          variant="ghost"
          onClick={() => form.setValue("components", appComponentsExample, { shouldValidate: true })}
        >
          예시 채우기
        </Button>
        <Button
          size="small"
          disabled={onboarding.isPending}
          onClick={() => {
            void form.handleSubmit((values) => {
              onboarding.mutate(values);
            })();
          }}
        >
          {onboarding.isPending ? "확인 중" : "온보딩 준비도 확인"}
        </Button>
      </div>
      {onboarding.isError ? (
        <InlineNotice tone="danger" title="준비도를 확인하지 못했습니다.">
          {safeAppErrorMessage(onboarding.error, "준비도를 확인하지 못했습니다.")}
        </InlineNotice>
      ) : null}
      {onboarding.data ? (
        <>
          <InlineNotice tone={onboarding.data.ready ? "success" : "warning"}>
            {onboarding.data.ready
              ? "필수 항목을 모두 충족했습니다. 발행할 수 있습니다."
              : "필수 항목이 충족되지 않아 발행이 차단됩니다."}
          </InlineNotice>
          <OnboardingChecklist checks={onboarding.data.checks ?? []} label="온보딩 준비도 점검 결과" />
        </>
      ) : null}
    </FormDialog>
  );
}
