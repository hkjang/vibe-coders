import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { formatDateTime } from "@/shared/utils/format";
import { ruleText } from "./routing-rule-edit-state";
import { QueryFailureNotice } from "./routing-ui";

/** Mounted only while this exact detail and its read lifetime are permitted. */
export function RoutingRuleDetailData({ id, owner }: { id: string; owner: FeatureReadOwner }) {
  const auth = useAuth();
  const query = useQuery({
    queryKey: featureOwnedKey(["routing", "rule-detail", id], owner),
    gcTime: 0,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(endpoints.domains.routing.rules.detail, {
        query: { id },
        signal,
        routeId: "routing.rules",
      });
      assertFeatureRead(owner, signal);
      if (data.rules.length > 1 || data.rules.some((row) => row.id !== id))
        throw new AppError("선택한 규칙의 정보를 확인하지 못했습니다.", { kind: "contract" });
      return data;
    },
  });
  const data = owner.isCurrent() && query.isSuccess && !query.isFetching ? query.data : undefined;
  const row = data?.rules[0];
  const safe = (text: string, empty = "없음") => ruleText(text, auth.credentialPrefixes, empty);
  const fields = row
    ? [
        ["규칙 ID", safe(row.id)],
        ["우선순위", String(row.priority)],
        ["모델 패턴", safe(row.match_pattern, "*")],
        ["복잡도 범위", `${row.min_complexity}–${row.max_complexity}`],
        ["대상 모델", safe(row.target_model)],
        ["대상 공급자", safe(row.target_provider, "자동 선택")],
        ["메모", safe(row.note).slice(0, 10000)],
        ["생성 시각", formatDateTime(row.created_at)],
      ]
    : [];
  return (
    <>
      {query.isPending || query.isFetching ? (
        <LoadingState label="라우팅 규칙 정보를 불러오는 중입니다." />
      ) : null}
      {query.isError ? (
        <QueryFailureNotice
          error={query.error}
          hasData={false}
          label="라우팅 규칙 상세"
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {data && !row ? (
        <InlineNotice tone="info" title="해당 라우팅 규칙이 없습니다.">
          규칙이 삭제되었거나 주소가 변경되었습니다.
        </InlineNotice>
      ) : null}
      {row ? (
        <>
          <Badge tone={row.enabled ? "success" : "muted"}>{row.enabled ? "사용 중" : "중지됨"}</Badge>
          <dl className="routing-rule-detail">
            {fields.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {row.note.length > 10000 ? <p>메모는 앞의 10,000자까지 표시합니다.</p> : null}
        </>
      ) : null}
    </>
  );
}
