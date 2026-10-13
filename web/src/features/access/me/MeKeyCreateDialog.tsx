import type { RefObject } from "react";
import { z } from "zod";
import type { CreateMeKeyBody } from "@/shared/api/domains/access";
import { meKeyScopeChoices } from "./me-key-scopes";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Input } from "@/shared/components/ui/Input";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { keyExpiryISO, keyExpirySchema } from "../key-expiry";

const keyFormSchema = z.object({
  name: z.string().min(1, "키 이름을 입력하세요."),
  expires_at: keyExpirySchema,
  scopes: z.array(z.string()),
});
type KeyForm = z.infer<typeof keyFormSchema>;

interface Props {
  grantable: readonly string[];
  canWrite: boolean;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onSubmit: (body: CreateMeKeyBody) => Promise<unknown>;
}
export function MeKeyCreateDialog({
  grantable,
  canWrite,
  returnFocusRef,
  onClose,
  onSubmit,
}: Props): React.JSX.Element {
  const form = useZodForm<KeyForm, KeyForm>(keyFormSchema, { name: "", expires_at: "", scopes: [] });
  const createScopes = form.watch("scopes");
  return (
    <FormDialog
      form={form}
      open
      submitDisabled={!canWrite}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      title="키 발급"
      description="비밀값은 발급 직후 한 번만 표시됩니다. 권한을 고르지 않으면 발급 시점에 내가 가진 권한으로 발급합니다. 역할 권한을 계속 상속하는 것은 아닙니다."
      submitLabel="발급"
      onSubmit={async (values) => {
        await onSubmit({
          name: values.name,
          ...(values.scopes.length > 0 ? { scopes: values.scopes } : {}),
          ...(values.expires_at ? { expires_at: keyExpiryISO(values.expires_at) } : {}),
        });
      }}
    >
      <FormField label="키 이름" required error={form.formState.errors.name?.message}>
        {(control) => <Input {...control} {...form.register("name")} />}
      </FormField>
      <FormField
        label="만료"
        description="브라우저의 현지 시각입니다. 비우면 무기한입니다."
        error={form.formState.errors.expires_at?.message}
      >
        {(control) => <Input {...control} type="datetime-local" {...form.register("expires_at")} />}
      </FormField>
      <fieldset>
        <legend>키 권한</legend>
        {grantable.length === 0 ? (
          <p className="access-note">
            선택할 수 있는 권한이 없습니다. 미선택 발급은 서버가 확인한 발급 시점의 내 권한을 사용합니다.
          </p>
        ) : (
          <div className="access-scope-grid">
            {meKeyScopeChoices(grantable).map(({ value: scope, label, description }) => (
              <Checkbox
                key={scope}
                label={label}
                description={description}
                checked={createScopes.includes(scope)}
                onChange={(event) => {
                  const current = form.getValues("scopes");
                  form.setValue(
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
        )}
      </fieldset>
    </FormDialog>
  );
}
