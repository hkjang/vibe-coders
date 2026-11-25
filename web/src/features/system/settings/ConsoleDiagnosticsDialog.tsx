import { useState, type RefObject } from "react";
import { useQuery } from "@tanstack/react-query";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Sheet } from "@/shared/components/ui/Sheet";
import { FormField } from "@/shared/components/form/FormField";
import { Select } from "@/shared/components/ui/Select";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { LoadingState } from "@/shared/components/state/PageStates";
import { ExpandableCellText } from "@/shared/data-table/ExpandableCellText";
import { formatDateTime } from "@/shared/utils/format";
import { diagnosticFailureLabels, diagnosticKindLabels, diagnosticSource } from "./diagnostic-labels";

const titles = new Map(migrationRegistry.map((feature) => [feature.featureId, feature.title]));

export function ConsoleDiagnosticsDialog({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const [days, setDays] = useState<7 | 30>(7);
  const query = useQuery({
    queryKey: ["ui-diagnostics", "summary", days],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.uiDiagnostics.summary, {
        query: { days },
        signal,
        routeId: "system.settings",
        referrerPolicy: "no-referrer",
      }),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const data = query.data;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="콘솔 오류 관측"
      description="현재 권한으로 확인할 수 있는 기능의 API 오류와 화면 오류를 확인합니다."
      returnFocusRef={returnFocusRef}
      size="wide"
      scrollLabel="콘솔 오류 관측 내용"
    >
      <div className="settings-tab-stack min-w-0">
        <div className="toolbar">
          <FormField label="오류 조회 기간">
            {(control) => (
              <Select
                {...control}
                value={days}
                onChange={(event) => setDays(event.target.value === "30" ? 30 : 7)}
              >
                <option value={7}>최근 7일</option>
                <option value={30}>최근 30일</option>
              </Select>
            )}
          </FormField>
          <Button
            aria-disabled={query.isFetching}
            aria-busy={query.isFetching}
            onClick={() => {
              if (!query.isFetching) void query.refetch();
            }}
          >
            오류 관측 새로고침
          </Button>
        </div>
        <p>
          수집은 ‘콘솔 사용 관측’ 설정을 켠 환경에서만 동작합니다. 오류 원문·호출 인자·주소의
          식별자·검색어·사용자 정보는 저장하지 않습니다. 요청 ID는 게이트웨이 생성 형식만 남깁니다.
        </p>
        <p>
          최근 30일 최대 10,000건을 보존합니다. 구버전·초기 로그인·취소된 요청·수집 상한·전송 실패로 빠진
          오류가 있을 수 있습니다. 조회 재시도의 실패도 별도 오류로 기록되므로 전체 장애 수나 성공률을
          의미하지 않습니다.
        </p>
        {query.isPending ? <LoadingState label="콘솔 오류를 조회하는 중입니다." /> : null}
        {query.isError ? (
          <InlineNotice tone="danger" title="오류 관측을 불러오지 못했습니다.">
            <p>
              {data
                ? "마지막 정상 조회 결과를 표시합니다. 새로고침으로 다시 확인하세요."
                : "권한과 연결을 확인한 뒤 새로고침하세요."}
            </p>
            {isAppError(query.error) && query.error.requestId ? (
              <p>요청 ID: {query.error.requestId}</p>
            ) : null}
          </InlineNotice>
        ) : null}
        {data ? (
          <>
            {!data.enabled ? (
              <InlineNotice title="현재 수집이 꺼져 있습니다.">
                보존 기간 안의 기존 관측 결과만 표시합니다.
              </InlineNotice>
            ) : null}
            <p>
              관측된 오류 {data.total.toLocaleString("ko-KR")}건 · 표시한 유형 {data.groups.length}개 · 나머지
              유형 {data.other_group_events.toLocaleString("ko-KR")}건
            </p>
            <p>
              {formatDateTime(data.from)} ~ {formatDateTime(data.to)}
            </p>
            {data.total === 0 ? (
              <InlineNotice title="이 기간에 관측된 오류가 없습니다.">
                수집 설정과 조회 기간을 확인하세요. 관측 기록이 없다는 것이 오류가 전혀 없었다는 뜻은
                아닙니다.
              </InlineNotice>
            ) : (
              <>
                <p className="text-muted">표가 잘리면 좌우로 이동해 추가 열을 확인하세요.</p>
                <h3>오류 유형별 집계</h3>
                <div
                  className="data-table-scroll"
                  role="region"
                  aria-label="콘솔 오류 유형별 집계"
                  tabIndex={0}
                >
                  <table className="data-table table-fixed" style={{ minWidth: "49rem" }}>
                    <caption className="sr-only">현재 권한 범위의 오류 유형 상위 100개</caption>
                    <colgroup>
                      {[13, 11, 28, 8, 16, 14, 10].map((width, index) => (
                        <col key={index} style={{ width: `${width}%` }} />
                      ))}
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col">기능</th>
                        <th scope="col">종류</th>
                        <th scope="col">발생 위치</th>
                        <th scope="col">상태</th>
                        <th scope="col">분류</th>
                        <th scope="col">UI 버전</th>
                        <th scope="col">건수</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.groups.map((row) => (
                        <tr
                          key={[
                            row.feature_id,
                            row.kind,
                            row.endpoint,
                            row.method,
                            row.status,
                            row.failure,
                            row.boundary,
                            row.ui_version,
                          ].join("|")}
                        >
                          <th scope="row">{titles.get(row.feature_id) ?? row.feature_id}</th>
                          <td>{diagnosticKindLabels[row.kind]}</td>
                          <td>
                            <ExpandableCellText value={diagnosticSource(row)} mono />
                          </td>
                          <td>{row.kind === "js_error" ? "해당 없음" : row.status || "응답 없음"}</td>
                          <td>{diagnosticFailureLabels[row.failure]}</td>
                          <td>{row.ui_version || "버전 확인 불가"}</td>
                          <td>{row.events.toLocaleString("ko-KR")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <h3>최근 오류</h3>
                <p>
                  최대 20건입니다. 요청 ID로 운영 로그를 찾을 수 있습니다. 임의 요청 ID와 화면 오류에는 요청
                  ID를 기록하지 않습니다.
                </p>
                <div className="data-table-scroll" role="region" aria-label="최근 콘솔 오류" tabIndex={0}>
                  <table className="data-table table-fixed" style={{ minWidth: "49rem" }}>
                    <caption className="sr-only">최근 오류의 수신 시각과 요청 ID</caption>
                    <colgroup>
                      {[22, 15, 18, 23, 22].map((width, index) => (
                        <col key={index} style={{ width: `${width}%` }} />
                      ))}
                    </colgroup>
                    <thead>
                      <tr>
                        <th scope="col">수신 시각</th>
                        <th scope="col">기능</th>
                        <th scope="col">종류·분류</th>
                        <th scope="col">발생 위치</th>
                        <th scope="col">요청 ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.recent.map((row, index) => (
                        <tr key={`${row.received_at}:${index}`}>
                          <th scope="row">
                            <time dateTime={row.received_at}>{formatDateTime(row.received_at)}</time>
                          </th>
                          <td>{titles.get(row.feature_id) ?? row.feature_id}</td>
                          <td>
                            {diagnosticKindLabels[row.kind]} · {diagnosticFailureLabels[row.failure]}
                          </td>
                          <td>
                            <ExpandableCellText value={diagnosticSource(row)} mono />
                          </td>
                          <td>
                            <ExpandableCellText value={row.request_id || "기록 안 함"} mono />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
