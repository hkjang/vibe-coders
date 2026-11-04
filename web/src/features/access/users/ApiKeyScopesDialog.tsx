import { useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";

import { QueryNotice } from "@/features/access/access-ui";
import { apiKeyScopeChoices } from "@/features/access/users/api-key-scopes";
import {
  confirmedScopeCatalog,
  unsupportedSelectedScopes,
  type ApiKeyRoleCatalog,
} from "@/features/access/users/api-key-scope-catalog";
import { accessKeys, useRolesQuery } from "@/features/access/users/use-access-admin";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { AppError } from "@/shared/api/error";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { FormField } from "@/shared/components/form/FormField";
import { KeyEditReview } from "./KeyEditReview";
import { keyEditError } from "./key-edit-error";
import { keyEditReasonSchema, useKeyEditReview } from "./use-key-edit-review";
import type { UpdateApiKeyBody } from "@/shared/api/domains/access";

const schema = z.object({ scopes: z.array(z.string()), reason: keyEditReasonSchema });
type ScopeForm = z.infer<typeof schema>;

interface Props {
  owner?: string;
  target: Pick<ApiKeyPublic, "id" | "name" | "scopes" | "revision">;
  onOpenChange: (open: boolean) => void;
  onSubmit: (
    id: string,
    scopes: string[],
    review: NonNullable<UpdateApiKeyBody["review"]>,
  ) => Promise<unknown>;
  returnFocusRef: RefObject<HTMLElement | null>;
  writeDisabled?: boolean;
}

export function ApiKeyScopesDialog({
  owner,
  target,
  onOpenChange,
  onSubmit,
  returnFocusRef,
  writeDisabled = false,
}: Props): React.JSX.Element {
  const queryClient = useQueryClient();
  const roles = useRolesQuery(true, owner);
  const catalogKey = owner ? [...accessKeys.roles, owner] : accessKeys.roles;
  // A refresh may replace the row while this editor is open. Neither its key
  // identity nor its original scope values become a new draft baseline.
  const [baseline] = useState(() => ({
    id: target.id,
    name: target.name,
    revision: target.revision,
    scopes: [...target.scopes].sort(),
  }));
  const review = useKeyEditReview(baseline, owner);
  const form = useZodForm<ScopeForm, ScopeForm>(schema, { scopes: [...baseline.scopes], reason: "" });
  const signature = JSON.stringify(form.watch());
  const selected = form.watch("scopes");
  const catalog = confirmedScopeCatalog(roles);
  const unsupported = catalog ? unsupportedSelectedScopes(selected, catalog) : [];
  const changed = JSON.stringify([...selected].sort()) !== JSON.stringify(baseline.scopes);

  return (
    <FormDialog
      errorFormatter={keyEditError}
      open
      form={form}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      title="API 키 권한 수정"
      description={`${baseline.name || "이름 없는 키"} 키가 사용할 권한을 선택합니다.`}
      submitLabel="권한 저장"
      submitDisabled={
        writeDisabled || !catalog || unsupported.length > 0 || !changed || !review.ready || review.attempted
      }
      onSubmit={(values) => {
        // Validation can yield while a refetch, error or catalog update arrives.
        // Read live query state at the actual PATCH boundary, not the render closure.
        const latest = confirmedScopeCatalog(queryClient.getQueryState<ApiKeyRoleCatalog>(catalogKey));
        if (!latest || unsupportedSelectedScopes(values.scopes, latest).length > 0) {
          throw new AppError("서버 허용 권한을 다시 확인한 뒤 저장하세요.", { kind: "contract" });
        }
        return onSubmit(
          baseline.id,
          [...values.scopes],
          review.begin(
            values.reason,
            !writeDisabled && changed && JSON.stringify(form.getValues()) === signature,
          ),
        );
      }}
    >
      {writeDisabled ? (
        <InlineNotice tone="warning">
          현재 화면에서 변경할 수 없습니다. 초안은 유지되며 취소할 수 있습니다.
        </InlineNotice>
      ) : null}
      <InlineNotice tone={selected.length === 0 ? "warning" : "info"}>
        모두 해제해 저장하면 선택된 권한이 없는 상태가 되며 역할 권한을 자동 상속하지 않습니다. 인증이
        활성화된 환경에서는 필요한 권한이 없는 호출이 거부됩니다. 키 사용을 중단하려면 별도의 ‘중지’ 작업을
        사용하세요.
      </InlineNotice>
      <p className="access-note">
        열린 뒤 목록이 갱신되어도 초안은 유지됩니다. 검토한 키 정보가 바뀌면 서버가 저장을 거부합니다.
      </p>
      {roles.isError ? (
        <QueryNotice
          error={roles.error}
          hasData={false}
          label="서버 허용 권한"
          onRetry={() => void roles.refetch()}
        />
      ) : !catalog ? (
        <InlineNotice tone="warning" title="서버 허용 권한을 확인하기 전에는 저장할 수 없습니다.">
          {roles.isFetching || roles.isPending
            ? "허용 권한 목록을 불러오는 중입니다."
            : "허용 권한 목록을 확인할 수 없습니다."}
        </InlineNotice>
      ) : null}
      {unsupported.length > 0 ? (
        <InlineNotice tone="danger" title="서버가 지원하지 않는 권한이 선택되어 있습니다.">
          <p>아래 권한을 임의로 제거하지 않았습니다. 확인 후 직접 해제해야 저장할 수 있습니다.</p>
          <ul>
            {unsupported.map((scope) => (
              <li key={scope}>{scope || "빈 권한 식별자"}</li>
            ))}
          </ul>
        </InlineNotice>
      ) : null}
      <Button
        size="small"
        variant="secondary"
        disabled={roles.isFetching}
        onClick={() => void roles.refetch()}
      >
        허용 권한 새로고침
      </Button>
      <fieldset>
        <legend>허용 권한</legend>
        <p className="access-note">
          {selected.length === 0
            ? "현재 선택: 선택된 권한 없음"
            : `현재 선택: 명시적 권한 ${selected.length}개`}
        </p>
        <div className="access-scope-grid">
          {apiKeyScopeChoices([...baseline.scopes, ...selected, ...(catalog ?? [])]).map(
            ({ value, label, description }) => (
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
            ),
          )}
        </div>
      </fieldset>
      <FormField
        label="변경 사유"
        required
        error={form.formState.errors.reason?.message}
        description="감사 이력에 기록됩니다. 비밀값이나 개인정보는 입력하지 마세요."
      >
        {(control) => <Input {...control} {...form.register("reason")} />}
      </FormField>
      <KeyEditReview
        changes={
          changed
            ? [
                {
                  label: "허용 권한",
                  before: baseline.scopes.join(", ") || "선택된 권한 없음",
                  after: [...selected].sort().join(", ") || "선택된 권한 없음",
                },
              ]
            : []
        }
        signature={signature}
        confirmation={review.confirmation}
        ready={review.ready && !!catalog && unsupported.length === 0}
        attempted={review.attempted}
        canWrite={!writeDisabled}
      />
    </FormDialog>
  );
}
