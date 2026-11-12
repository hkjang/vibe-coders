import { useQuery } from "@tanstack/react-query";
import type { RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { managedRoleLabel } from "@/config/ui-labels";
import { statusLabel } from "@/features/access/access-format";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { apiClient } from "@/shared/api/client";
import { accountPageSchema } from "@/shared/api/domains/account-page.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { LegacyLink } from "@/shared/components/ui/LegacyLink";
import { Sheet } from "@/shared/components/ui/Sheet";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatDateTime } from "@/shared/utils/format";
import { validAccountId } from "./account-detail-model";
import { accessKeys } from "./use-access-admin";

export function AccountDetail({
  values,
  owner,
  onClose,
  returnFocusRef,
}: {
  values: readonly string[];
  owner: FeatureReadOwner;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const auth = useAuth();
  const id = values[0] ?? "";
  const valid = values.length === 1 && validAccountId(id, auth.credentialPrefixes);
  const result = useQuery({
    queryKey: featureOwnedKey([...accessKeys.users, "account-detail", valid ? id : null], owner),
    enabled: valid && owner.readable && !owner.denied,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      if (!valid) throw new AppError("계정 상세 주소를 확인하세요.", { kind: "contract" });
      const parsed = accountPageSchema.safeParse(
        await apiClient.request(endpoints.domains.access.users.accounts, {
          query: { view: "accounts", id, limit: 1, offset: 0 },
          signal,
          routeId: "access.users",
        }),
      );
      assertFeatureRead(owner, signal);
      if (!parsed.success)
        throw new AppError("계정 상세의 형식을 확인하지 못했습니다.", { kind: "contract" });
      const data = parsed.data;
      if (
        data.limit !== 1 ||
        data.offset !== 0 ||
        data.total > 1 ||
        data.accounts.length !== data.total ||
        data.accounts.some((row) => row.id !== id)
      )
        throw new AppError("선택한 계정의 정보를 확인하지 못했습니다.", { kind: "contract" });
      return data;
    },
  });
  const data = valid && result.isSuccess && !result.isFetching ? result.data : undefined;
  const row = data?.accounts[0];
  const safe = (value: string) =>
    containsPotentialSecret(value, auth.credentialPrefixes) ? "보호된 값" : value || "미지정";
  return (
    <Sheet
      open={values.length > 0}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="로그인 계정 상세"
      description="계정의 역할·상태·주 소속 팀을 조회합니다. 현재 상세 주소를 다시 열 수 있습니다."
      returnFocusRef={returnFocusRef}
      scrollLabel="로그인 계정 정보"
      footer={
        <>
          {canOpenLegacyAdmin(auth) ? (
            <LegacyLink className="button button-secondary button-default" href="/admin#/users">
              기존 사용자·팀 화면
            </LegacyLink>
          ) : null}
          <Button onClick={onClose}>닫기</Button>
        </>
      }
    >
      {!valid ? (
        <InlineNotice tone="danger" title="계정 상세 주소를 확인하세요.">
          계정 ID는 하나만 지정할 수 있습니다. 비어 있거나 너무 길거나 보호가 필요한 ID는 상세 조회하지
          않습니다.
        </InlineNotice>
      ) : null}
      {valid && (result.isPending || result.isFetching) ? (
        <LoadingState label="로그인 계정 정보를 불러오는 중입니다." />
      ) : null}
      {valid && result.isError ? (
        <QueryNotice
          error={result.error}
          hasData={false}
          label="로그인 계정 상세"
          onRetry={() => void result.refetch()}
        />
      ) : null}
      {data && !row ? (
        <InlineNotice tone="info" title="조회 가능한 로그인 계정이 없습니다.">
          계정이 삭제되었거나 현재 조회 범위에 포함되지 않습니다. 목록으로 돌아가 계정을 다시 선택하세요.
        </InlineNotice>
      ) : null}
      {row ? (
        <dl className="access-stack account-detail-values">
          <div>
            <dt>이름</dt>
            <dd>{safe(row.name)}</dd>
          </div>
          <div>
            <dt>이메일</dt>
            <dd>{safe(row.email)}</dd>
          </div>
          <div>
            <dt>계정 ID</dt>
            <dd className="mono">{row.id}</dd>
          </div>
          <div>
            <dt>역할</dt>
            <dd>{safe(managedRoleLabel(row.role))}</dd>
          </div>
          <div>
            <dt>상태</dt>
            <dd>{safe(statusLabel(row.status))}</dd>
          </div>
          <div>
            <dt>주 소속 팀</dt>
            <dd>{row.team_id ? safe(row.team_name || row.team_id) : "미소속"}</dd>
          </div>
          {row.team_id ? (
            <div>
              <dt>팀 ID</dt>
              <dd className="mono">{safe(row.team_id)}</dd>
            </div>
          ) : null}
          <div>
            <dt>생성 시각</dt>
            <dd>
              <time dateTime={row.created_at} title={row.created_at}>
                {formatDateTime(row.created_at)}
              </time>
            </dd>
          </div>
        </dl>
      ) : null}
      {data ? <UpdatedAt at={result.dataUpdatedAt} /> : null}
    </Sheet>
  );
}
