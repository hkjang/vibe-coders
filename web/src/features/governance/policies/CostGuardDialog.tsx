import {
  costGuardDescription,
  costGuardException,
  costGuardFormSchema,
  type CostGuardInput,
  type CostGuardValues,
} from "./cost-guard-state";
import type { CostGuardDraft, CostGuardEditor } from "./use-cost-guard";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { CostGuardContractNotice } from "@/shared/components/form/CostGuardContractNotice";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Switch } from "@/shared/components/ui/Switch";
import { Button } from "@/shared/components/ui/Button";
import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export function CostGuardDialog({
  target,
  editor,
  canWrite,
}: {
  target: CostGuardDraft;
  editor: CostGuardEditor;
  canWrite: boolean;
}): React.JSX.Element {
  const form = useZodForm<CostGuardInput, CostGuardValues>(costGuardFormSchema, {
    enabled: target.baseline.enabled,
    thresholdKrw: String(target.baseline.threshold_krw),
  });
  const enabled = form.watch("enabled");
  const threshold = form.watch("thresholdKrw");
  return (
    <FormDialog
      open
      form={form}
      title="비용 보호 설정 수정"
      description={costGuardDescription}
      submitLabel="비용 보호 설정 저장"
      submitDisabled={!canWrite || !editor.confirmed}
      returnFocusRef={editor.returnFocusRef}
      onOpenChange={(open) => {
        if (!open) editor.close(target.instance);
      }}
      onSubmit={(values) => editor.submit(target, values)}
    >
      <InlineNotice tone="info">{costGuardException}</InlineNotice>
      <CostGuardContractNotice />
      <p>
        조회가 갱신되어도 열린 초안은 바뀌지 않습니다. 다른 관리자의 동시 변경을 막지는 않습니다. 저장 후 모든
        서버에 즉시 반영되거나 진행 중 요청이 취소되는 것은 아닙니다.
      </p>
      {!canWrite ? (
        <InlineNotice tone="warning">설정 변경 권한(admin:write)이 없어 조회만 할 수 있습니다.</InlineNotice>
      ) : null}
      {editor.supported && !editor.confirmed ? (
        <InlineNotice tone="warning" title="현재 설정을 확인하기 전에는 저장할 수 없습니다.">
          {editor.query.isError
            ? safeAppErrorMessage(editor.query.error, "비용 보호 설정을 조회하지 못했습니다.")
            : "현재 설정을 다시 확인하세요. 입력한 초안은 유지됩니다."}
          {isAppError(editor.query.error) && editor.query.error.requestId ? (
            <span className="request-id"> 요청 ID: {editor.query.error.requestId}</span>
          ) : null}
        </InlineNotice>
      ) : null}
      <Button
        size="small"
        disabled={editor.query.isFetching || editor.pending}
        onClick={() => void editor.query.refetch()}
      >
        현재 설정 다시 조회
      </Button>
      <Switch
        label="예상 비용 보호 사용"
        checked={enabled}
        disabled={!canWrite}
        onCheckedChange={(checked) => form.setValue("enabled", checked, { shouldDirty: true })}
      />
      <FormField
        label="요청당 임계값 (원)"
        required
        description="0 이상 금액을 입력하세요. 소수 금액도 허용합니다. 0은 이 검사로 제한하지 않는 설정입니다."
        error={form.formState.errors.thresholdKrw?.message}
      >
        {(control) => (
          <Input
            {...control}
            {...form.register("thresholdKrw")}
            type="number"
            min={0}
            step="any"
            disabled={!canWrite}
          />
        )}
      </FormField>
      {!enabled || (threshold.trim() !== "" && Number(threshold) === 0) ? (
        <InlineNotice tone="warning">
          사용을 끄거나 임계값을 0으로 저장하면 이 예상 비용 검사가 요청을 차단하지 않습니다. 다른 예산·정책
          설정은 그대로 유지됩니다.
        </InlineNotice>
      ) : null}
    </FormDialog>
  );
}
