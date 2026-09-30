import type { UseFormReturn } from "react-hook-form";
import { apiKeyScopeChoices } from "@/features/access/users/api-key-scopes";
import type { CreateKeyForm } from "@/features/access/users/api-key-form";
import { FormField } from "@/shared/components/form/FormField";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Input } from "@/shared/components/ui/Input";

export function ApiKeyCreateFields({
  form: createForm,
}: {
  form: UseFormReturn<CreateKeyForm>;
}): React.JSX.Element {
  const createScopes = createForm.watch("scopes");
  return (
    <>
      <FormField label="이름" required error={createForm.formState.errors.name?.message}>
        {(control) => <Input {...control} {...createForm.register("name")} />}
      </FormField>
      <FormField label="소유자">
        {(control) => <Input {...control} {...createForm.register("owner")} />}
      </FormField>
      <FormField label="팀">{(control) => <Input {...control} {...createForm.register("team")} />}</FormField>
      <FormField label="역할" description="비우면 기본 역할을 사용합니다.">
        {(control) => <Input {...control} {...createForm.register("role")} />}
      </FormField>
      <FormField
        label="허용 IP"
        description="쉼표 또는 공백으로 구분합니다. 비우면 IP 제한이 없습니다. 발급 후에는 바꿀 수 없습니다."
      >
        {(control) => <Input {...control} {...createForm.register("allowed_ips")} />}
      </FormField>
      <FormField label="허용 모델" description="쉼표 또는 공백으로 구분합니다.">
        {(control) => <Input {...control} {...createForm.register("allowed_models")} />}
      </FormField>
      <FormField label="차단 모델" description="쉼표 또는 공백으로 구분합니다.">
        {(control) => <Input {...control} {...createForm.register("denied_models")} />}
      </FormField>
      <FormField label="월 예산 한도(원)">
        {(control) => (
          <Input {...control} type="number" min={0} {...createForm.register("budget_limit_krw")} />
        )}
      </FormField>
      <FormField label="만료" description="비우면 무기한입니다.">
        {(control) => <Input {...control} type="datetime-local" {...createForm.register("expires_at")} />}
      </FormField>
      <fieldset>
        <legend>허용 권한</legend>
        <p className="access-note">선택하지 않으면 발급 시 역할의 기본 권한을 적용합니다.</p>
        <div className="access-scope-grid">
          {apiKeyScopeChoices([]).map(({ value: scope, label, description }) => (
            <Checkbox
              key={scope}
              label={label}
              description={description}
              checked={createScopes.includes(scope)}
              onChange={(event) => {
                const current = createForm.getValues("scopes");
                createForm.setValue(
                  "scopes",
                  event.target.checked
                    ? [...current, scope].sort()
                    : current.filter((item) => item !== scope),
                  { shouldDirty: true },
                );
              }}
            />
          ))}
        </div>
      </fieldset>
    </>
  );
}
