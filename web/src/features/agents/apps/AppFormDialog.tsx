import { useEffect, type RefObject } from "react";
import { useAppOperationAccess } from "./app-scope";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppDefinitionReview } from "./AppDefinitionReview";
import { AppOnboardingReview } from "./AppOnboardingReview";
import { useAppDefinitionReview } from "./use-app-definition-review";
import { Checkbox } from "@/shared/components/ui/Checkbox";

import {
  appComponentsExample,
  appFormDefaults,
  appFormSchema,
  appStatusOptions,
  type AppFormInput,
  type AppFormOutput,
} from "@/features/agents/apps/app-form";
import type { WorkApp } from "@/shared/api/domains/agents.schemas";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";

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
  const access = useAppOperationAccess();
  const auth = useAuth();
  const form = useZodForm<AppFormInput, AppFormOutput>(appFormSchema, appFormDefaults(app));
  const review = useAppDefinitionReview(form);
  const { reset } = form;
  useEffect(() => {
    if (open) reset(appFormDefaults(app));
  }, [app, open, reset]);
  const errors = form.formState.errors;

  return (
    <FormDialog
      description="AI 업무 앱의 기본 정보와 구성 요소(JSON)를 입력합니다. 발행 전에 온보딩 준비도를 확인할 수 있습니다."
      form={form}
      onOpenChange={onOpenChange}
      onSubmit={async (values) => {
        review.assertReviewed(values);
        access.assertCurrent();
        await onSubmit(values);
      }}
      open={open}
      returnFocusRef={returnFocusRef}
      submitLabel={app ? "수정 저장" : "앱 만들기"}
      submitDisabled={!access.allowed || !review.confirmed}
      scrollBody
      scrollHint="검토 내용은 위아래로 스크롤해 확인할 수 있습니다."
      title={app ? "AI 업무 앱 수정" : "새 AI 업무 앱"}
    >
      {!access.allowed ? (
        <InlineNotice tone="warning">{access.reason} 초안은 유지됩니다.</InlineNotice>
      ) : null}
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
          onClick={() =>
            form.setValue("components", appComponentsExample, { shouldValidate: true, shouldDirty: true })
          }
        >
          예시 채우기
        </Button>
        <Button size="small" onClick={() => void review.review()}>
          변경 내용 검토
        </Button>
      </div>
      {review.values ? (
        <>
          <AppDefinitionReview app={app} values={review.values} prefixes={auth.credentialPrefixes} />
          <Checkbox
            checked={review.confirmed}
            onChange={(event) => review.confirm(event.currentTarget.checked)}
            label="변경 내용과 적용 범위를 확인했습니다."
            disabled={!access.allowed}
          />
        </>
      ) : (
        <p role="status">저장 전에 변경 내용을 검토하고 적용 범위를 확인하세요.</p>
      )}
      <AppOnboardingReview form={form} owner={app?.owner ?? owner} />
    </FormDialog>
  );
}
