import type { RefObject } from "react";
import { useEffect } from "react";
import { z } from "zod";

import type { ProviderCatalogRow } from "@/features/gateway/providers/provider-catalog";
import type { ProviderSLOWriteBody, ProviderWriteBody } from "@/shared/api/domains/gateway";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";

const numberText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0), {
      message: `${label}은(는) 0 이상의 숫자여야 합니다.`,
    })
    .refine((value) => value === "" || Number(value) <= max, {
      message: `${label}이(가) 허용 범위를 넘었습니다.`,
    });

const providerFormSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "공급자 이름을 입력하세요.")
    .max(200)
    .refine((value) => !/[,\s]/u.test(value), "공급자 이름에는 공백과 쉼표를 넣을 수 없습니다."),
  base_url: z
    .string()
    .trim()
    .min(1, "기본 URL을 입력하세요.")
    .refine((value) => /^https?:\/\//u.test(value), "http 또는 https로 시작하는 URL이어야 합니다."),
  api_key: z.string().default(""),
  timeout_ms: numberText("제한 시간", 600_000),
  model_patterns: z.string().trim().max(2000).default(""),
  failover_group: z.string().trim().max(200).default(""),
  priority: numberText("우선순위", 100_000),
  enabled: z.boolean().default(true),
});

type ProviderFormInput = z.input<typeof providerFormSchema>;
type ProviderFormOutput = z.output<typeof providerFormSchema>;

function providerWriteBody(values: ProviderFormOutput): ProviderWriteBody {
  return {
    name: values.name,
    base_url: values.base_url,
    // Empty means "keep the stored secret": the server never returns it, so the
    // console never renders or caches provider credentials.
    api_key: values.api_key.trim() === "" ? undefined : values.api_key,
    timeout_ms: values.timeout_ms === "" ? undefined : Number(values.timeout_ms),
    model_patterns: values.model_patterns,
    failover_group: values.failover_group,
    priority: values.priority === "" ? undefined : Number(values.priority),
    enabled: values.enabled,
  };
}

const emptyProvider: ProviderFormInput = {
  name: "",
  base_url: "",
  api_key: "",
  timeout_ms: "",
  model_patterns: "",
  failover_group: "",
  priority: "",
  enabled: true,
};

interface ProviderFormDialogProps {
  onOpenChange: (open: boolean) => void;
  onSubmit: (body: ProviderWriteBody) => Promise<unknown>;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  row?: ProviderCatalogRow;
}

export function ProviderFormDialog({
  onOpenChange,
  onSubmit,
  open,
  returnFocusRef,
  row,
}: ProviderFormDialogProps): React.JSX.Element {
  const form = useZodForm<ProviderFormInput, ProviderFormOutput>(providerFormSchema, emptyProvider);
  const { reset } = form;

  useEffect(() => {
    if (!open) return;
    reset(
      row
        ? {
            name: row.provider.name,
            base_url: row.provider.base_url,
            api_key: "",
            timeout_ms: String(row.provider.timeout_ms),
            model_patterns: row.provider.model_patterns,
            failover_group: row.provider.failover_group,
            priority: String(row.provider.priority),
            enabled: row.provider.enabled,
          }
        : emptyProvider,
    );
  }, [open, reset, row]);

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      form={form}
      title={row ? "공급자 수정" : "공급자 추가"}
      description="이름과 기본 URL은 필수입니다. API 키는 입력할 때만 교체되고 화면에 다시 표시되지 않습니다."
      onSubmit={(values) => onSubmit(providerWriteBody(values))}
    >
      <FormField label="이름" required error={form.formState.errors.name?.message}>
        {(control) => <Input {...control} readOnly={row !== undefined} {...form.register("name")} />}
      </FormField>
      <FormField label="기본 URL" required error={form.formState.errors.base_url?.message}>
        {(control) => <Input {...control} {...form.register("base_url")} />}
      </FormField>
      <FormField
        label="API 키"
        description={
          row?.provider.api_key_configured
            ? "저장된 키가 있습니다. 비워 두면 그대로 유지합니다."
            : "입력 전용입니다. 저장 후에는 다시 볼 수 없습니다."
        }
      >
        {(control) => <Input {...control} type="password" autoComplete="off" {...form.register("api_key")} />}
      </FormField>
      <FormField
        label="모델 패턴"
        description="쉼표 또는 줄바꿈으로 구분합니다. 비우면 모든 모델을 받습니다."
      >
        {(control) => <Textarea {...control} rows={2} {...form.register("model_patterns")} />}
      </FormField>
      <FormField label="장애 전환 그룹" description="같은 그룹의 공급자끼리 자동 대체합니다.">
        {(control) => <Input {...control} {...form.register("failover_group")} />}
      </FormField>
      <FormField
        label="우선순위"
        description="숫자가 작을수록 먼저 시도합니다."
        error={form.formState.errors.priority?.message}
      >
        {(control) => <Input {...control} inputMode="numeric" {...form.register("priority")} />}
      </FormField>
      <FormField
        label="제한 시간(ms)"
        description="비우면 게이트웨이 기본값을 사용합니다."
        error={form.formState.errors.timeout_ms?.message}
      >
        {(control) => <Input {...control} inputMode="numeric" {...form.register("timeout_ms")} />}
      </FormField>
      <Checkbox
        label="활성"
        description="비활성 공급자는 라우팅 후보에서 제외됩니다."
        {...form.register("enabled")}
      />
    </FormDialog>
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
      title="공급자 SLO 설정"
      description="0을 넣으면 해당 항목은 평가하지 않습니다. 가용성과 비율은 0~1 사이의 값입니다."
      onSubmit={(values) =>
        onSubmit({
          provider: row?.provider.name ?? "",
          availability_target: Number(values.availability_target || 0),
          p95_latency_target_ms: Number(values.p95_latency_target_ms || 0),
          error_rate_target: Number(values.error_rate_target || 0),
          fallback_rate_target: Number(values.fallback_rate_target || 0),
          enabled: values.enabled,
          note: values.note,
        })
      }
    >
      <FormField label="가용성 목표" error={form.formState.errors.availability_target?.message}>
        {(control) => <Input {...control} inputMode="decimal" {...form.register("availability_target")} />}
      </FormField>
      <FormField label="P95 지연 목표(ms)" error={form.formState.errors.p95_latency_target_ms?.message}>
        {(control) => <Input {...control} inputMode="numeric" {...form.register("p95_latency_target_ms")} />}
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
        label="SLO 평가 사용"
        description="끄면 목표는 저장되지만 위반으로 표시하지 않습니다."
        {...form.register("enabled")}
      />
    </FormDialog>
  );
}
