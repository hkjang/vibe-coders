import type { RefObject } from "react";
import { useEffect } from "react";
import { z } from "zod";

import { ProviderCreateDialog, ProviderEditDialog } from "@/features/gateway/providers/ProviderEditDialog";
import type { ProviderCatalogRow } from "@/features/gateway/providers/provider-catalog";
import { numberText } from "@/features/gateway/providers/provider-form";
import type { ProviderSLOWriteBody, ProviderWriteBody } from "@/shared/api/domains/gateway";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useProviderWriteAccess } from "./use-provider-write-access";

interface ProviderFormDialogProps {
  credentialPrefixes?: readonly string[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: ProviderWriteBody) => Promise<unknown>;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  row?: ProviderCatalogRow;
  initialEnabled?: boolean;
}

export function ProviderFormDialog(props: ProviderFormDialogProps): React.JSX.Element | null {
  if (!props.open) return null;
  return props.row ? (
    <ProviderEditDialog key={props.row.identity} {...props} row={props.row} />
  ) : (
    <ProviderCreateDialog {...props} />
  );
}

const sloFormSchema = z.object({
  availability_target: numberText("가용성 목표", 1),
  p95_latency_target_ms: numberText("P95 지연 목표", 600_000),
  error_rate_target: numberText("오류율 목표", 1),
  fallback_rate_target: numberText("장애 전환율 목표", 1),
  enabled: z.boolean().default(true),
  note: z.string().trim().max(1000).default(""),
});

type SloFormInput = z.input<typeof sloFormSchema>;
type SloFormOutput = z.output<typeof sloFormSchema>;

const emptySlo: SloFormInput = {
  availability_target: "0.99",
  p95_latency_target_ms: "5000",
  error_rate_target: "0.02",
  fallback_rate_target: "0.1",
  enabled: true,
  note: "",
};

interface ProviderSloDialogProps {
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: ProviderSLOWriteBody) => Promise<unknown>;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  row?: ProviderCatalogRow;
}

export function ProviderSloDialog({
  onOpenChange,
  onSubmit,
  open,
  returnFocusRef,
  row,
}: ProviderSloDialogProps): React.JSX.Element {
  const access = useProviderWriteAccess();
  const form = useZodForm<SloFormInput, SloFormOutput>(sloFormSchema, emptySlo);
  const { reset } = form;

  useEffect(() => {
    if (!open) return;
    reset(
      row?.slo
        ? {
            availability_target: String(row.slo.availability_target),
            p95_latency_target_ms: String(row.slo.p95_latency_target_ms),
            error_rate_target: String(row.slo.error_rate_target),
            fallback_rate_target: String(row.slo.fallback_rate_target),
            enabled: row.slo.enabled,
            note: row.slo.note,
          }
        : emptySlo,
    );
  }, [open, reset, row]);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      form={form}
      title="공급자 서비스 수준 목표"
      description="서비스 수준 목표(SLO)를 설정합니다. 0을 넣으면 해당 항목은 평가하지 않습니다. 가용성과 비율은 0~1 사이의 값입니다."
      submitDisabled={!access.allowed}
      onSubmit={(values) => {
        access.assertCurrent();
        return onSubmit({
          provider: (row?.nameRedacted ? row.identity : row?.provider.name) ?? "",
          availability_target: Number(values.availability_target || 0),
          p95_latency_target_ms: Number(values.p95_latency_target_ms || 0),
          error_rate_target: Number(values.error_rate_target || 0),
          fallback_rate_target: Number(values.fallback_rate_target || 0),
          enabled: values.enabled,
          note: values.note,
        });
      }}
    >
      {!access.allowed ? <InlineNotice tone="warning">{access.reason}</InlineNotice> : null}
      <fieldset className="form-grid form-dialog-fields" disabled={!access.allowed}>
        <FormField label="가용성 목표" error={form.formState.errors.availability_target?.message}>
          {(control) => <Input {...control} inputMode="decimal" {...form.register("availability_target")} />}
        </FormField>
        <FormField label="P95 지연 목표(ms)" error={form.formState.errors.p95_latency_target_ms?.message}>
          {(control) => (
            <Input {...control} inputMode="numeric" {...form.register("p95_latency_target_ms")} />
          )}
        </FormField>
        <FormField label="오류율 목표" error={form.formState.errors.error_rate_target?.message}>
          {(control) => <Input {...control} inputMode="decimal" {...form.register("error_rate_target")} />}
        </FormField>
        <FormField label="장애 전환율 목표" error={form.formState.errors.fallback_rate_target?.message}>
          {(control) => <Input {...control} inputMode="decimal" {...form.register("fallback_rate_target")} />}
        </FormField>
        <FormField label="메모">
          {(control) => <Textarea {...control} rows={2} {...form.register("note")} />}
        </FormField>
        <Checkbox
          label="서비스 목표 평가 사용"
          description="끄면 목표는 저장되지만 위반으로 표시하지 않습니다."
          {...form.register("enabled")}
        />
      </fieldset>
    </FormDialog>
  );
}
