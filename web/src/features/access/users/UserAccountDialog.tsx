import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useState, type RefObject } from "react";
import { z } from "zod";

import { useAuth } from "@/app/auth/AuthProvider";
import { managedRoleLabel } from "@/config/ui-labels";
import { accessKeys } from "@/features/access/users/use-access-admin";
import { apiClient } from "@/shared/api/client";
import type { AuthUserRow } from "@/shared/api/domains/access.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Select } from "@/shared/components/ui/Select";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { containsPotentialSecret } from "@/shared/security/secrets";

const routeId = "access.users";
const access = endpoints.domains.access;
const fields = z.object({
  email: z.string(),
  password: z.string(),
  name: z.string(),
  role: z.string().min(1, "역할을 선택하세요."),
  status: z.enum(["active", "disabled"]),
  team_id: z.string(),
});
type Values = z.infer<typeof fields>;

interface Props {
  user?: AuthUserRow;
  canWrite: boolean;
  writeDeniedReason: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

/** Mounted per editor opening. Catalogs and form secrets never cross principals. */
export function UserAccountDialog({
  user,
  canWrite,
  writeDeniedReason,
  onClose,
  returnFocusRef,
}: Props): React.JSX.Element | null {
  const auth = useAuth();
  const owner = useFeatureReadOwner(routeId, "user-account-editor");
  const [initialOwner] = useState(owner.id);
  const current = owner.id === initialOwner && owner.readable && !owner.denied;
  useLayoutEffect(() => {
    if (!current) onClose();
  }, [current, onClose]);
  const roleChangeAllowed = !user || auth.mode !== "authenticated" || auth.user?.role !== "team_admin";
  const currentWriteScope =
    auth.mode !== "authenticated" ||
    auth.user?.scopes.includes("admin:write") === true ||
    (!user && auth.user?.role === "team_admin");
  const write = useFeatureMutationAccess(
    [routeId],
    canWrite && roleChangeAllowed && currentWriteScope,
    roleChangeAllowed ? writeDeniedReason : "팀 관리자는 로그인 계정의 역할·상태를 변경할 수 없습니다.",
  );
  const client = useQueryClient();
  const queryOptions = {
    queryKey: featureOwnedKey([...accessKeys.roles, "account-editor"], owner),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(access.roles.list, { signal, routeId });
      assertFeatureRead(owner, signal);
      const names = data.roles.map((row) => row.role);
      // Reject an ambiguous or unsafe catalog, rather than silently assigning
      // a fallback role when the browser cannot represent the current value.
      if (
        !names.length ||
        new Set(names).size !== names.length ||
        names.some(
          (name) =>
            !name ||
            name.trim() !== name ||
            name.length > 256 ||
            [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) ||
            containsPotentialSecret(name, auth.credentialPrefixes),
        )
      ) {
        throw new AppError("역할 목록을 확인하지 못했습니다.", { kind: "contract" });
      }
      return names;
    },
    staleTime: 0,
    gcTime: 0,
    retry: false as const,
  };
  const catalog = useQuery({
    ...queryOptions,
    enabled: current,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const names = catalog.isSuccess && !catalog.isFetching ? catalog.data : undefined;
  const schema = fields.superRefine((values, context) => {
    if (user) return;
    if (!z.email().safeParse(values.email).success)
      context.addIssue({ code: "custom", path: ["email"], message: "올바른 이메일 주소를 입력하세요." });
    if (values.password.length < 8)
      context.addIssue({ code: "custom", path: ["password"], message: "비밀번호는 8자 이상이어야 합니다." });
  });
  const form = useZodForm<Values, Values>(schema, {
    email: "",
    password: "",
    name: "",
    role: user?.role || "developer",
    status: user?.status === "disabled" ? "disabled" : "active",
    team_id: user?.team_id ?? "",
  });
  const selected = form.watch("role");
  const known = names?.includes(selected) === true;
  const save = useMutationFeedback<Values, unknown>({
    gcTime: 0,
    ownsResult: owner.isCurrent,
    mutate: async (values) => {
      write.assertCurrent();
      assertFeatureRead(owner);
      const state = client.getQueryState<string[]>(queryOptions.queryKey);
      if (
        state?.status !== "success" ||
        state.fetchStatus !== "idle" ||
        state.isInvalidated ||
        !state.data?.includes(values.role)
      ) {
        throw new AppError("역할 목록을 다시 확인한 뒤 저장하세요.", { kind: "contract" });
      }
      // Recheck against the server immediately before writing; authorization is
      // still exclusively enforced by the existing create/update handlers.
      const fresh = await client.fetchQuery(queryOptions);
      assertFeatureRead(owner);
      write.assertCurrent();
      if (!fresh.includes(values.role))
        throw new AppError("선택한 역할이 더 이상 존재하지 않습니다. 역할을 다시 선택하세요.", {
          kind: "contract",
        });
      if (user)
        return apiClient.request(withPathParams(access.users.update, { id: user.id }), {
          body: { role: values.role, status: values.status, team_id: values.team_id },
          routeId,
          retryUnauthorized: false,
        });
      return apiClient.request(access.users.create, {
        body: {
          email: values.email,
          password: values.password,
          ...(values.name ? { name: values.name } : {}),
          role: values.role,
          ...(values.team_id ? { team_id: values.team_id } : {}),
        },
        routeId,
        retryUnauthorized: false,
      });
    },
    invalidates: [accessKeys.users],
    successMessage: user ? "사용자 정보를 변경했습니다." : "사용자를 등록했습니다.",
  });
  if (!current) return null;
  return (
    <FormDialog
      form={form}
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      title={user ? "사용자 변경" : "사용자 등록"}
      description={
        user
          ? `${user.email} 계정의 역할, 상태, 팀을 변경합니다. 이름과 비밀번호는 변경할 수 없습니다.`
          : "콘솔 로그인 계정을 만듭니다. 역할 목록에는 내장·사용자 정의 역할이 포함되며 부여 권한은 서버에서 검증합니다."
      }
      submitLabel={user ? "저장" : "등록"}
      submitDisabled={!write.allowed || !known}
      onSubmit={async (values) => {
        await save.mutateAsync(values);
        assertFeatureRead(owner);
      }}
    >
      {!write.allowed ? <InlineNotice tone="warning">{write.reason}</InlineNotice> : null}
      {!user ? (
        <>
          <FormField label="이메일" required error={form.formState.errors.email?.message}>
            {(control) => <Input {...control} type="email" {...form.register("email")} />}
          </FormField>
          <FormField
            label="비밀번호"
            required
            description="8자 이상. 등록 후에는 이 화면에서 변경할 수 없습니다."
            error={form.formState.errors.password?.message}
          >
            {(control) => (
              <Input
                {...control}
                type="password"
                autoComplete="new-password"
                {...form.register("password")}
              />
            )}
          </FormField>
          <FormField label="이름">{(control) => <Input {...control} {...form.register("name")} />}</FormField>
        </>
      ) : null}
      <FormField
        label="역할"
        description="서버에 등록된 역할입니다. 사용자 정의 역할은 최고 관리자만 부여할 수 있습니다."
        error={form.formState.errors.role?.message}
      >
        {(control) => (
          <Select {...control} {...form.register("role")} value={selected} disabled={!names}>
            {!known ? (
              <option value={selected} disabled>
                {names ? "현재 역할을 목록에서 확인할 수 없습니다." : "역할 목록 확인 중"}
              </option>
            ) : null}
            {names?.map((role) => (
              <option key={role} value={role}>
                {managedRoleLabel(role)}
              </option>
            ))}
          </Select>
        )}
      </FormField>
      {catalog.isFetching ? <p role="status">역할 목록을 확인하고 있습니다.</p> : null}
      {catalog.isError ? (
        <InlineNotice tone="warning" title="역할 목록을 불러오지 못했습니다.">
          저장을 중단했습니다. 입력 내용은 유지됩니다.{" "}
          <Button type="button" onClick={() => void catalog.refetch()}>
            역할 목록 다시 조회
          </Button>
        </InlineNotice>
      ) : null}
      {names && !known ? (
        <InlineNotice tone="warning">
          선택한 역할이 목록에 없습니다. 다른 역할을 명시적으로 선택하세요.
        </InlineNotice>
      ) : null}
      {user ? (
        <FormField label="상태" description="중지하면 해당 사용자의 모든 세션이 즉시 폐기됩니다.">
          {(control) => (
            <Select {...control} {...form.register("status")}>
              <option value="active">사용</option>
              <option value="disabled">중지</option>
            </Select>
          )}
        </FormField>
      ) : null}
      <FormField label="팀" description="팀 ID 또는 팀 이름. 비우면 팀 배정을 해제합니다.">
        {(control) => <Input {...control} {...form.register("team_id")} />}
      </FormField>
    </FormDialog>
  );
}
