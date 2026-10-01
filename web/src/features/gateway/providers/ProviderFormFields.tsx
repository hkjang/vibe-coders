import type { UseFormReturn } from "react-hook-form";

import type { ProviderCatalogRow } from "@/features/gateway/providers/provider-catalog";
import {
  redactedProviderURL,
  type ProviderFormInput,
  type ProviderFormOutput,
} from "@/features/gateway/providers/provider-form";
import { FormField } from "@/shared/components/form/FormField";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";

export function ProviderFormFields({
  form,
  row,
}: {
  form: UseFormReturn<ProviderFormInput, unknown, ProviderFormOutput>;
  row?: ProviderCatalogRow;
}): React.JSX.Element {
  return (
    <>
      <FormField label="이름" required error={form.formState.errors.name?.message}>
        {(control) => <Input {...control} readOnly={row !== undefined} {...form.register("name")} />}
      </FormField>
      <FormField
        label="기본 URL"
        required
        error={form.formState.errors.base_url?.message}
        description={
          row?.provider.base_url === redactedProviderURL
            ? "서버가 기존 주소를 숨겼습니다. 표시값을 그대로 두면 기존 주소를 유지하고, 새 URL을 입력하면 교체합니다."
            : undefined
        }
      >
        {(control) => <Input {...control} {...form.register("base_url")} />}
      </FormField>
      <FormField
        label="API 키"
        error={form.formState.errors.api_key?.message}
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
      <FormField
        label="장애 전환 그룹"
        description="같은 그룹의 공급자를 대체 후보로 사용합니다. 호출 성공을 보장하지 않습니다."
      >
        {(control) => <Input {...control} {...form.register("failover_group")} />}
      </FormField>
      <FormField
        label="우선순위"
        description="작은 양의 정수부터 시도합니다. 비우면 기존 값을 유지하고, 0은 서버 기본값을 사용합니다."
        error={form.formState.errors.priority?.message}
      >
        {(control) => <Input {...control} inputMode="numeric" {...form.register("priority")} />}
      </FormField>
      <FormField
        label="제한 시간(ms)"
        description="밀리초 단위 정수입니다. 비우거나 0을 입력하면 게이트웨이 기본값을 사용합니다."
        error={form.formState.errors.timeout_ms?.message}
      >
        {(control) => <Input {...control} inputMode="numeric" {...form.register("timeout_ms")} />}
      </FormField>
      <Checkbox
        label="활성"
        description="비활성 공급자는 라우팅 후보에서 제외됩니다."
        {...form.register("enabled")}
      />
    </>
  );
}
