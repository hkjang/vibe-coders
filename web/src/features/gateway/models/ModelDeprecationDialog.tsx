import type { RefObject } from "react";
import { deprecationSchema, type DeprecationInput, type DeprecationOutput } from "./model-governance-form";
import { ModelQueryFailure } from "./ModelGovernanceState";
import { useModelAccess } from "./use-model-access";
import { useModelListPrerequisite } from "./use-model-governance";
import type { ModelDeprecationWriteBody } from "@/shared/api/domains/gateway";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import "./model-governance.css";

export function ModelDeprecationDialog({
  close,
  save,
  returnFocusRef,
  refresh,
  refreshing,
  queryError,
}: {
  close: () => void;
  save: (body: ModelDeprecationWriteBody) => Promise<unknown>;
  returnFocusRef: RefObject<HTMLElement | null>;
  refresh: () => void;
  refreshing: boolean;
  queryError?: unknown;
}) {
  const { write } = useModelAccess();
  const list = useModelListPrerequisite("deprecations");
  const reason = write.reason ?? list.reason;
  const form = useZodForm<DeprecationInput, DeprecationOutput>(deprecationSchema, {
    model_glob: "",
    replacement: "",
    sunset_date: "",
    message: "",
  });
  return (
    <FormDialog
      open
      title="지원 종료 정책"
      description="같은 정규화 패턴(서버 기준 앞뒤 공백 제거·대소문자 무시)은 기존 정책을 갱신합니다. 다른 패턴은 새 정책이며 기존 항목의 이름 변경이 아닙니다."
      form={form}
      returnFocusRef={returnFocusRef}
      submitDisabled={reason !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      onSubmit={(values) => {
        write.assertCurrent();
        list.assertCurrent();
        return save({
          model_glob: values.model_glob,
          replacement: values.replacement || undefined,
          sunset_date: values.sunset_date || undefined,
          message: values.message || undefined,
        });
      }}
    >
      {reason ? <InlineNotice tone="warning">{reason}</InlineNotice> : null}
      <InlineNotice tone="warning">
        같은 패턴의 정책을 갱신할 때도 빈 선택 항목은 기존 값을 지웁니다. 다른 관리자의 동시 변경을 막거나
        병합하지 않습니다.
      </InlineNotice>
      <p>
        별도 ID로 가져온 기존 항목은 같은 패턴을 입력해도 덮어쓰지 않을 수 있습니다. 새 항목이 함께 남을 수
        있으므로 목록을 확인하세요.
      </p>
      <p>
        종료일은 UTC 기준입니다. 날짜를 비우면 경고만 하며, 날짜에 도달한 뒤 대체 모델이 없으면 호출을
        차단합니다. 여러 인스턴스에는 캐시 갱신까지 반영 시차가 있을 수 있습니다.
      </p>
      {queryError ? (
        <ModelQueryFailure
          title="지원 종료 정책 목록을 확인하지 못했습니다."
          error={queryError}
          retry={refresh}
        />
      ) : (
        <Button size="small" variant="secondary" disabled={refreshing} onClick={refresh}>
          정책 목록 다시 조회
        </Button>
      )}
      <fieldset
        className="form-grid form-dialog-fields model-deprecation-form"
        disabled={reason !== undefined}
      >
        <FormField label="모델 패턴" required error={form.formState.errors.model_glob?.message}>
          {(control) => <Input {...control} {...form.register("model_glob")} />}
        </FormField>
        <FormField
          label="대체 모델"
          description="종료일 도달 후 대체할 모델입니다. 비우면 종료일 이후 차단합니다."
          error={form.formState.errors.replacement?.message}
        >
          {(control) => <Input {...control} {...form.register("replacement")} />}
        </FormField>
        <FormField
          label="종료일"
          description="UTC 날짜 YYYY-MM-DD. 비우면 경고만 표시합니다."
          error={form.formState.errors.sunset_date?.message}
        >
          {(control) => <Input {...control} placeholder="2026-12-31" {...form.register("sunset_date")} />}
        </FormField>
        <FormField label="안내 문구" error={form.formState.errors.message?.message}>
          {(control) => <Textarea {...control} rows={2} {...form.register("message")} />}
        </FormField>
      </fieldset>
    </FormDialog>
  );
}
