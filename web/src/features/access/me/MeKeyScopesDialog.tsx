import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useCallback, useState, useSyncExternalStore, type RefObject } from "react";
import { z } from "zod";

import { QueryNotice } from "@/features/access/access-ui";
import {
  confirmedMeScopeCatalog,
  meKeyScopeChoices,
  ungrantableMeScopes,
  type MeKeyCatalog,
} from "@/features/access/me/me-key-scopes";
import { meKeys } from "@/features/access/me/use-me-queries";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { AppError } from "@/shared/api/error";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";

const schema = z.object({ scopes: z.array(z.string()) });
type ScopeForm = z.infer<typeof schema>;

interface Props {
  target: ApiKeyPublic;
  catalogQuery: UseQueryResult<MeKeyCatalog>;
  onOpenChange: (open: boolean) => void;
  onSubmit: (id: string, scopes: readonly string[]) => Promise<unknown>;
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function MeKeyScopesDialog({
  target,
  catalogQuery,
  onOpenChange,
  onSubmit,
  returnFocusRef,
}: Props): React.JSX.Element {
  const queryClient = useQueryClient();
  const [baseline] = useState(() => ({
    id: target.id,
    name: target.name,
    scopes: [...target.scopes].sort(),
  }));
  const form = useZodForm<ScopeForm, ScopeForm>(schema, { scopes: [...baseline.scopes] });
  const selected = form.watch("scopes");
  // Query observers do not expose isInvalidated. Observe the raw state too so
  // invalidate-without-refetch disables the button, not only the PATCH boundary.
  const catalogState = useSyncExternalStore(
    useCallback((notify) => queryClient.getQueryCache().subscribe(notify), [queryClient]),
    useCallback(() => queryClient.getQueryState<MeKeyCatalog>(meKeys.keys), [queryClient]),
  );
  const catalog = confirmedMeScopeCatalog(catalogState);
  const ungrantable = catalog ? ungrantableMeScopes(selected, catalog) : [];

  return (
    <FormDialog
      open
      form={form}
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      title="내 API 키 권한 수정"
      description={`${baseline.name || "이름 없는 키"} 키가 사용할 권한을 선택합니다.`}
      submitLabel="권한 저장"
      submitDisabled={!catalog || ungrantable.length > 0}
      onSubmit={(values) => {
        const latest = confirmedMeScopeCatalog(queryClient.getQueryState<MeKeyCatalog>(meKeys.keys));
        if (!latest || ungrantableMeScopes(values.scopes, latest).length > 0) {
          throw new AppError("내가 부여할 수 있는 권한을 다시 확인한 뒤 저장하세요.", { kind: "contract" });
        }
        return onSubmit(baseline.id, [...values.scopes]);
      }}
    >
      <InlineNotice tone={selected.length === 0 ? "warning" : "info"}>
        모두 해제해 저장하면 선택된 권한이 없는 상태가 되며 역할 권한을 자동 상속하지 않습니다. 인증이
        활성화된 환경에서는 필요한 권한이 없는 호출이 거부됩니다. 키 사용을 중단하려면 별도의 ‘폐기’ 작업을
        사용하세요.
      </InlineNotice>
      <p className="access-note">
        열린 뒤 목록이 갱신되어도 이 초안은 바뀌지 않습니다. 다른 곳에서의 동시 변경을 막지는 않습니다.
      </p>
      {catalogQuery.isError ? (
        <QueryNotice
          error={catalogQuery.error}
          hasData={false}
          label="내가 부여할 수 있는 권한"
          onRetry={() => void catalogQuery.refetch()}
        />
      ) : !catalog ? (
        <InlineNotice tone="warning" title="부여 가능한 권한을 확인하기 전에는 저장할 수 없습니다.">
          {catalogQuery.isFetching || catalogQuery.isPending
            ? "권한 목록을 불러오는 중입니다."
            : "권한 목록을 확인할 수 없습니다."}
        </InlineNotice>
      ) : catalog.length === 0 ? (
        <InlineNotice tone="info">
          현재 부여할 수 있는 권한이 없습니다. 모두 해제한 상태로 저장할 수 있습니다.
        </InlineNotice>
      ) : null}
      {ungrantable.length > 0 ? (
        <InlineNotice tone="danger" title="현재 내가 부여할 수 없는 권한이 선택되어 있습니다.">
          <p>아래 권한을 임의로 제거하지 않았습니다. 확인 후 직접 해제해야 저장할 수 있습니다.</p>
          <ul>
            {ungrantable.map((scope) => (
              <li key={scope}>{scope || "빈 권한 식별자"}</li>
            ))}
          </ul>
        </InlineNotice>
      ) : null}
      <Button
        size="small"
        variant="secondary"
        disabled={catalogQuery.isFetching}
        onClick={() => void catalogQuery.refetch()}
      >
        허용 권한 새로고침
      </Button>
      <fieldset>
        <legend>키 권한</legend>
        <p className="access-note">
          {selected.length === 0
            ? "현재 선택: 선택된 권한 없음"
            : `현재 선택: 명시적 권한 ${selected.length}개`}
        </p>
        <div className="access-scope-grid">
          {meKeyScopeChoices([
            ...baseline.scopes,
            ...selected,
            ...(catalogQuery.data?.grantable_scopes ?? []),
          ]).map(({ value, label, description }) => (
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
