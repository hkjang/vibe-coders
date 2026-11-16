import { useQuery } from "@tanstack/react-query";
import { useMemo, type RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import { roleLabel } from "@/config/ui-labels";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
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
import { formatDateTime, formatKRW } from "@/shared/utils/format";
import { keyLifecycle } from "../key-lifecycle";
import { useKeyExpiryClock } from "../use-key-expiry-clock";
import { validAPIKeyDetailId } from "./api-key-detail-model";
import { accessKeys } from "./use-access-admin";

export function ApiKeyDetail({
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
  const supported = versionAtLeast(auth.backendVersion, "v0.86.101");
  const valid = values.length === 1 && validAPIKeyDetailId(id, auth.credentialPrefixes);
  const result = useQuery({
    queryKey: featureOwnedKey([...accessKeys.apiKeys, "detail", valid ? id : null], owner),
    enabled: valid && supported && owner.readable && !owner.denied,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(endpoints.domains.access.apiKeys.list, {
        query: { id },
        signal,
        routeId: "access.users",
      });
      assertFeatureRead(owner, signal);
      if (data.api_keys.length > 1 || data.api_keys.some((row) => row.id !== id))
        throw new AppError("선택한 API 키의 정보를 확인하지 못했습니다.", { kind: "contract" });
      return data;
    },
  });
  const data = valid && supported && result.isSuccess && !result.isFetching ? result.data : undefined;
  const row = data?.api_keys[0];
  const clockRows = useMemo(() => (row ? [row] : []), [row]);
  const now = useKeyExpiryClock(clockRows);
  const lifecycle = row ? keyLifecycle(row, now) : undefined;
  const safe = (text: string) =>
    containsPotentialSecret(text, auth.credentialPrefixes) ? "보호된 값" : text || "미지정";
  const list = (values: readonly string[]) => (values.length ? safe(values.join(", ")) : "제한 없음");
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="API 키 상세"
      description="선택한 키의 상태·권한·사용 제한을 조회합니다. 비밀값은 표시하지 않습니다."
      returnFocusRef={returnFocusRef}
      scrollLabel="API 키 정보"
      footer={
        <>
          {canOpenLegacyAdmin(auth) ? (
            <LegacyLink className="button button-secondary button-default" href="/admin#/users">
              기존 사용자·키 화면
            </LegacyLink>
          ) : null}
          <Button onClick={onClose}>닫기</Button>
        </>
      }
    >
      {!valid ? (
        <InlineNotice tone="danger" title="API 키 상세 주소를 확인하세요.">
          키 ID는 하나만 지정할 수 있습니다. 비밀값 대신 목록에서 키를 선택하세요.
        </InlineNotice>
      ) : null}
      {valid && !supported ? (
        <InlineNotice tone="info" title="서버 업데이트가 필요합니다.">
          상세 주소 조회는 v0.86.101 이상에서 지원합니다. 현재 목록이나 기존 화면을 이용하세요.
        </InlineNotice>
      ) : null}
      {valid && supported && (result.isPending || result.isFetching) ? (
        <LoadingState label="API 키 정보를 불러오는 중입니다." />
      ) : null}
      {valid && supported && result.isError ? (
        <QueryNotice
          error={result.error}
          hasData={false}
          label="API 키 상세"
          onRetry={() => void result.refetch()}
        />
      ) : null}
      {data && !row ? (
        <InlineNotice tone="info" title="조회 가능한 API 키가 없습니다.">
          키가 삭제되었거나 현재 팀의 조회 범위에 포함되지 않습니다.
        </InlineNotice>
      ) : null}
      {row && lifecycle ? (
        <dl className="access-stack">
          <div>
            <dt>이름</dt>
            <dd className="registered-team-detail-value">{safe(row.name)}</dd>
          </div>
          <div>
            <dt>키 ID</dt>
            <dd className="registered-team-detail-value mono">{row.id}</dd>
          </div>
          <div>
            <dt>상태</dt>
            <dd>
              <Badge tone={lifecycle.tone}>{lifecycle.label}</Badge>
            </dd>
          </div>
          <div>
            <dt>소유자</dt>
            <dd className="registered-team-detail-value">{safe(row.owner)}</dd>
          </div>
          <div>
            <dt>팀</dt>
            <dd className="registered-team-detail-value">{safe(row.team)}</dd>
          </div>
          <div>
            <dt>역할</dt>
            <dd>{row.role ? safe(roleLabel(row.role)) : "미지정"}</dd>
          </div>
          <div>
            <dt>권한 범위</dt>
            <dd className="registered-team-detail-value">
              {row.scopes.length ? safe(row.scopes.join(", ")) : "선택된 권한 없음"}
            </dd>
          </div>
          <div>
            <dt>허용 IP</dt>
            <dd className="registered-team-detail-value">{list(row.allowed_ips)}</dd>
          </div>
          <div>
            <dt>허용 모델</dt>
            <dd className="registered-team-detail-value">{list(row.allowed_models)}</dd>
          </div>
          <div>
            <dt>차단 모델</dt>
            <dd className="registered-team-detail-value">
              {row.denied_models.length ? list(row.denied_models) : "차단 없음"}
            </dd>
          </div>
          <div>
            <dt>허용 공급자</dt>
            <dd className="registered-team-detail-value">{list(row.allowed_providers)}</dd>
          </div>
          <div>
            <dt>차단 공급자</dt>
            <dd className="registered-team-detail-value">
              {row.denied_providers.length ? list(row.denied_providers) : "차단 없음"}
            </dd>
          </div>
          <div>
            <dt>예산 한도</dt>
            <dd>{row.budget_limit_krw > 0 ? formatKRW(row.budget_limit_krw) : "제한 없음"}</dd>
          </div>
          <div>
            <dt>생성 시각</dt>
            <dd>{formatDateTime(row.created_at)}</dd>
          </div>
          <div>
            <dt>만료 시각</dt>
            <dd>{row.expires_at ? formatDateTime(row.expires_at) : "무기한"}</dd>
          </div>
          {row.revoked_at ? (
            <div>
              <dt>폐기 시각</dt>
              <dd>{formatDateTime(row.revoked_at)}</dd>
            </div>
          ) : null}
          {row.replaced_by ? (
            <div>
              <dt>교체된 새 키 ID</dt>
              <dd className="registered-team-detail-value mono">{safe(row.replaced_by)}</dd>
            </div>
          ) : null}
          {row.grace_ends_at ? (
            <div>
              <dt>교체 유예 종료</dt>
              <dd>{formatDateTime(row.grace_ends_at)}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {data ? <UpdatedAt at={result.dataUpdatedAt} /> : null}
    </Sheet>
  );
}
