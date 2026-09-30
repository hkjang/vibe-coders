import { useState, type RefObject } from "react";
import { z } from "zod";

import { apiKeyScopeChoices } from "@/features/access/users/api-key-scopes";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";

const schema = z.object({ scopes: z.array(z.string()) });
type ScopeForm = z.infer<typeof schema>;

interface Props {
  target: Pick<ApiKeyPublic, "id" | "name" | "scopes">;
  onOpenChange: (open: boolean) => void;
  onSubmit: (id: string, scopes: string[]) => Promise<unknown>;
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function ApiKeyScopesDialog({
  target,
  onOpenChange,
  onSubmit,
  returnFocusRef,
}: Props): React.JSX.Element {
  // A refresh may replace the row while this editor is open. Neither its key
  // identity nor its original scope values become a new draft baseline.
  const [baseline] = useState(() => ({
    id: target.id,
    name: target.name,
    scopes: [...target.scopes].sort(),
  }));
  const form = useZodForm<ScopeForm, ScopeForm>(schema, { scopes: [...baseline.scopes] });
  const selected = form.watch("scopes");

  return (
    <FormDialog
      open
      form={form}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      title="API 키 권한 수정"
      description={`${baseline.name || "이름 없는 키"} 키가 사용할 권한을 선택합니다.`}
      submitLabel="권한 저장"
      onSubmit={(values) => onSubmit(baseline.id, [...values.scopes])}
    >
      <InlineNotice tone="info">
        모두 해제하면 권한을 금지하는 것이 아니라 키에 지정된 역할의 권한을 상속합니다. 열린 뒤 목록이
        갱신되어도 이 초안은 바뀌지 않습니다. 다른 관리자의 동시 변경을 막지는 않습니다.
      </InlineNotice>
      <fieldset>
        <legend>허용 권한</legend>
        <p className="access-note">
          {selected.length === 0
            ? "현재 선택: 역할 권한 상속"
            : `현재 선택: 명시적 권한 ${selected.length}개`}
        </p>
        <div className="access-scope-grid">
          {apiKeyScopeChoices(baseline.scopes).map(({ value, label, description }) => (
            <Checkbox
              key={value}
              label={label}
              description={description}
              checked={selected.includes(value)}
              onChange={(event) => {
                const current = form.getValues("scopes");
                form.setValue(
                  "scopes",
                  event.target.checked
                    ? [...current, value].sort()
                    : current.filter((scope) => scope !== value),
                  { shouldDirty: true },
                );
              }}
            />
          ))}
        </div>
      </fieldset>
    </FormDialog>
  );
}
