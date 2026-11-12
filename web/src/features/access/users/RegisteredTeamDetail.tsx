import { useQuery } from "@tanstack/react-query";
import type { RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { apiClient } from "@/shared/api/client";
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
import { validRegisteredTeamId } from "./registered-team-detail-model";
import { accessKeys } from "./use-access-admin";

export function RegisteredTeamDetail({
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
  const valid = values.length === 1 && validRegisteredTeamId(id, auth.credentialPrefixes);
  const result = useQuery({
    queryKey: featureOwnedKey([...accessKeys.teams, "registered-detail", valid ? id : null], owner),
    enabled: valid && owner.readable && !owner.denied,
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      if (!valid) throw new AppError("팀 상세 주소를 확인하세요.", { kind: "contract" });
      const data = await apiClient.request(endpoints.domains.access.teams.registered, {
        query: { view: "registered", id, limit: 1, offset: 0 },
        signal,
        routeId: "access.users",
      });
      assertFeatureRead(owner, signal);
      if (
        data.limit !== 1 ||
        data.offset !== 0 ||
        data.total > 1 ||
        data.auth_teams.length !== data.total ||
        data.auth_teams.some((row) => row.id !== id)
      )
        throw new AppError("선택한 팀의 등록 정보를 확인하지 못했습니다.", { kind: "contract" });
      return data;
    },
  });
  const data = valid && result.isSuccess && !result.isFetching ? result.data : undefined;
  const row = data?.auth_teams[0];
  return (
    <Sheet
      open={values.length > 0}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="등록 팀 상세"
      description="등록된 팀의 이름과 생성·수정 시각을 조회합니다. 현재 상세 주소를 다시 열 수 있습니다."
      returnFocusRef={returnFocusRef}
      scrollLabel="등록 팀 정보"
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
        <InlineNotice tone="danger" title="팀 상세 주소를 확인하세요.">
          팀 ID는 하나만 지정할 수 있습니다. 비어 있거나 너무 길거나 보호가 필요한 ID는 상세 조회하지
          않습니다.
        </InlineNotice>
      ) : null}
      {valid && (result.isPending || result.isFetching) ? (
        <LoadingState label="등록 팀 정보를 불러오는 중입니다." />
      ) : null}
      {valid && result.isError ? (
        <QueryNotice
          error={result.error}
          hasData={false}
          label="등록 팀 상세"
          onRetry={() => void result.refetch()}
        />
      ) : null}
      {data && !row ? (
        <InlineNotice tone="info" title="조회 가능한 등록 팀이 없습니다.">
          팀이 삭제되었거나 현재 조회 범위에 포함되지 않습니다. 목록으로 돌아가 팀을 다시 선택하세요.
        </InlineNotice>
      ) : null}
      {row ? (
        <dl className="access-stack">
          <div>
            <dt>팀 이름</dt>
            <dd className="registered-team-detail-value">
              {containsPotentialSecret(row.name, auth.credentialPrefixes)
                ? "보호된 팀 이름"
                : row.name || "미지정"}
            </dd>
          </div>
          <div>
            <dt>팀 ID</dt>
            <dd className="registered-team-detail-value mono">{row.id}</dd>
          </div>
          <div>
            <dt>생성 시각</dt>
            <dd>
              <time dateTime={row.created_at} title={row.created_at}>
                {formatDateTime(row.created_at)}
              </time>
            </dd>
          </div>
          <div>
            <dt>수정 시각</dt>
            <dd>
              <time dateTime={row.updated_at} title={row.updated_at}>
                {formatDateTime(row.updated_at)}
              </time>
            </dd>
          </div>
        </dl>
      ) : null}
      {data ? <UpdatedAt at={result.dataUpdatedAt} /> : null}
    </Sheet>
  );
}
