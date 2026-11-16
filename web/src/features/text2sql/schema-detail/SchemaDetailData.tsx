import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import { LoadingState } from "@/shared/components/state/PageStates";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatDateTime } from "@/shared/utils/format";
import { schemaDetailText } from "./schema-detail-model";

export function SchemaDetailData({ name, owner }: { name: string; owner: FeatureReadOwner }) {
  const auth = useAuth();
  const [expanded, setExpanded] = useState(false);
  const [tablePage, setTablePage] = useState(0);
  const query = useQuery({
    queryKey: featureOwnedKey(["text2sql", "schema-detail", name], owner),
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const data = await apiClient.request(endpoints.domains.text2sql.schemaDetail, {
        query: { view: "schema", name },
        signal,
        routeId: "text2sql.overview",
      });
      assertFeatureRead(owner, signal);
      if (data.schema.name !== name)
        throw new AppError("선택한 스키마의 정보를 확인하지 못했습니다.", { kind: "contract" });
      return data;
    },
  });
  const data = owner.isCurrent() && query.isSuccess && !query.isFetching ? query.data : undefined;
  const row = data?.schema;
  const safe = (value: string, empty = "—") => schemaDetailText(value, auth.credentialPrefixes, empty);
  const error = query.error;
  const missing = isAppError(error) && error.status === 404;
  const requestId =
    isAppError(error) &&
    error.requestId &&
    error.requestId.length <= 200 &&
    !containsPotentialSecret(error.requestId, auth.credentialPrefixes)
      ? error.requestId
      : undefined;
  const tables = row?.allowed_tables ?? [];
  const pageCount = Math.max(1, Math.ceil(tables.length / 50));
  const page = Math.min(tablePage, pageCount - 1);
  return (
    <>
      {query.isPending || query.isFetching ? <LoadingState label="스키마 정보를 불러오는 중입니다." /> : null}
      {query.isError ? (
        <InlineNotice
          tone={missing ? "info" : "danger"}
          title={missing ? "해당 스키마를 찾을 수 없습니다." : "스키마 상세를 불러오지 못했습니다."}
          actions={<Button onClick={() => void query.refetch()}>다시 시도</Button>}
        >
          {missing
            ? "삭제되었거나 현재 계정의 조회 범위 밖에 있습니다."
            : safeAppErrorMessage(error, "잠시 후 다시 시도하세요.")}
          {requestId ? <p>요청 ID: {requestId}</p> : null}
        </InlineNotice>
      ) : null}
      {row && data ? (
        <>
          <SectionCard
            title={safe(row.name)}
            description="저장된 스키마의 현재 등록 정보입니다. 실행 연결이나 권한을 변경하지 않습니다."
            actions={
              <>
                <Badge tone={row.enabled ? "success" : "muted"}>{row.enabled ? "사용 중" : "중지됨"}</Badge>
                {row.is_default ? <Badge tone="info">기본 스키마</Badge> : null}
                <Button disabled={query.isFetching} onClick={() => void query.refetch()}>
                  새로고침
                </Button>
              </>
            }
          >
            <KeyValueList
              items={[
                { label: "스키마 이름", value: safe(row.name) },
                { label: "소속 팀", value: safe(row.team, "공용") },
                { label: "SQL 문법", value: safe(row.dialect) },
                { label: "스키마 버전", value: row.version },
                {
                  label: "수집 시각",
                  value: containsPotentialSecret(row.collected_at, auth.credentialPrefixes)
                    ? "비공개"
                    : row.collected_at
                      ? formatDateTime(row.collected_at)
                      : "미수집",
                },
                {
                  label: "수정 시각",
                  value: containsPotentialSecret(row.updated_at, auth.credentialPrefixes)
                    ? "비공개"
                    : row.updated_at
                      ? formatDateTime(row.updated_at)
                      : "미확인",
                },
                { label: "원본 지문", value: safe(row.source_fingerprint), mono: true },
              ]}
            />
          </SectionCard>
          {!data.raw_content_available ? (
            <InlineNotice tone="info" title="스키마 설명과 허용 테이블은 비공개입니다.">
              현재 계정은 등록 정보만 조회할 수 있습니다.
            </InlineNotice>
          ) : (
            <>
              <SectionCard
                title="스키마 설명"
                description="SQL 생성에 사용하는 설명입니다. 이 화면에서는 실행하지 않습니다."
                actions={
                  <Button
                    aria-expanded={expanded}
                    aria-controls="schema-context"
                    onClick={() => setExpanded(!expanded)}
                  >
                    {expanded ? "설명 접기" : "설명 보기"}
                  </Button>
                }
              >
                <div id="schema-context">
                  {expanded ? (
                    <>
                      {row.schema_text.length > 16384 ? (
                        <p>
                          설명이 길어 이 화면에서는 본문을 표시하지 않습니다. 전체 설명은 기존 관리 화면에서
                          확인하세요.
                        </p>
                      ) : (
                        <pre className="schema-detail-code" tabIndex={0} aria-label="스키마 설명 본문">
                          {safe(row.schema_text, "등록된 설명이 없습니다.")}
                        </pre>
                      )}
                    </>
                  ) : (
                    <p>필요할 때 설명을 펼쳐 확인하세요.</p>
                  )}
                </div>
              </SectionCard>
              <SectionCard
                title="허용 테이블"
                description={
                  tables.length
                    ? `${tables.length}개 · 이 목록은 스키마 설정이며 실제 실행 권한은 별도로 적용됩니다.`
                    : "스키마에 별도 테이블 제한이 없습니다. 실제 실행 권한은 별도로 적용됩니다."
                }
              >
                {tables.length ? (
                  <>
                    <ul className="schema-detail-tables" aria-label="허용 테이블">
                      {tables.slice(page * 50, (page + 1) * 50).map((table, index) => (
                        <li key={index}>{safe(table)}</li>
                      ))}
                    </ul>
                    <nav aria-label="허용 테이블 페이지">
                      <span role="status">
                        {page + 1} / {pageCount}페이지
                      </span>
                      <Button disabled={page === 0} onClick={() => setTablePage(page - 1)}>
                        이전 테이블
                      </Button>
                      <Button disabled={page + 1 === pageCount} onClick={() => setTablePage(page + 1)}>
                        다음 테이블
                      </Button>
                    </nav>
                  </>
                ) : (
                  <p>별도 제한 없음</p>
                )}
              </SectionCard>
            </>
          )}
        </>
      ) : null}
    </>
  );
}
