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
import {
  assertFeatureRead,
  featureOwnedKey,
  useFeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { formatDateTime } from "@/shared/utils/format";
import { actionLabels, actionSuccessRate } from "./action-labels";

const titles = new Map(migrationRegistry.map((feature) => [feature.featureId, feature.title]));
export function ConsoleActionsDialog({
  onClose,
  returnFocusRef,
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const [days, setDays] = useState<7 | 30>(7);
  const owner = useFeatureReadOwner("system.settings", "ui-action-observations");
  const query = useQuery({
    queryKey: featureOwnedKey(["ui-actions", "summary", days], owner),
    enabled: owner.readable && !owner.denied,
    queryFn: async ({ signal }) => {
      assertFeatureRead(owner, signal);
      const result = await apiClient.request(endpoints.uiActions.summary, {
        query: { days },
        signal,
        routeId: "system.settings",
        referrerPolicy: "no-referrer",
      });
      assertFeatureRead(owner, signal);
      return result;
    },
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const data = owner.readable && !owner.denied ? query.data : undefined;
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="콘솔 작업 결과"
      description="현재 권한으로 확인할 수 있는 기능의 작업 결과를 살펴봅니다."
      returnFocusRef={returnFocusRef}
      size="wide"
      scrollLabel="콘솔 작업 결과 내용"
    >
      <div className="settings-tab-stack min-w-0">
        <div className="toolbar">
          <FormField label="작업 조회 기간">
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
            aria-disabled={query.isFetching || !owner.readable}
            aria-busy={query.isFetching}
            onClick={() => {
              if (!owner.readable || query.isFetching) return;
              if (owner.denied) owner.restart();
              else void query.refetch();
            }}
          >
            작업 결과 새로고침
          </Button>
        </div>
        <p>
          완료율은 확인된 결과 중 완료된 비율입니다. 통신 중단 등으로 결과가 확인되지 않은 작업은 분모에서
          제외합니다. 실행 요청 접수는 작업 실행이 끝났다는 뜻이 아닙니다.
        </p>
        <p>
          ‘콘솔 사용 관측’ 설정을 켠 환경의 관측 기록입니다. 입력값·응답·사용자 정보는 저장하지 않습니다. 최근
          30일 최대 10,000건을 보존하며, 취소·수집 상한·전송 실패 등으로 누락될 수 있어 전체 서비스 성공률과
          다릅니다.
        </p>
        {!owner.readable || owner.denied ? (
          <InlineNotice tone="warning" title="작업 결과 조회 권한을 확인하세요.">
            현재 계정의 설정 조회 권한과 기능 허용 상태를 확인한 뒤 다시 조회하세요.
          </InlineNotice>
        ) : query.isPending ? (
          <LoadingState label="작업 결과를 조회하는 중입니다." />
        ) : null}
        {query.isError && !owner.denied ? (
          <InlineNotice tone="danger" title="작업 결과를 불러오지 못했습니다.">
            <p>
              {data
                ? "마지막 정상 조회 결과입니다. 새로고침으로 다시 확인하세요."
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
              완료율 {actionSuccessRate(data)} · 완료 {data.success.toLocaleString("ko-KR")}건 · 거부{" "}
              {data.rejected.toLocaleString("ko-KR")}건 · 확인 불가 {data.unknown.toLocaleString("ko-KR")}건
            </p>
            <p>
              {formatDateTime(data.from)} ~ {formatDateTime(data.to)}
            </p>
            {data.success + data.rejected + data.unknown === 0 ? (
              <InlineNotice title="이 기간에 관측된 작업이 없습니다.">
                수집 설정과 조회 기간을 확인하세요. 기록이 없다는 것이 모든 작업이 성공했다는 뜻은 아닙니다.
              </InlineNotice>
            ) : (
              <>
                <p className="text-muted">표가 잘리면 좌우로 이동해 추가 열을 확인하세요.</p>
                <div
                  className="data-table-scroll"
                  role="region"
                  aria-label="콘솔 기능별 작업 결과"
                  tabIndex={0}
                >
                  <table className="data-table table-fixed" style={{ minWidth: "49rem" }}>
                    <caption className="sr-only">현재 권한 범위의 작업 결과 상위 100개</caption>
                    <colgroup>
                      {[22, 17, 15, 15, 10, 10, 11].map((width, index) => (
                        <col key={index} style={{ width: `${width}%` }} />
                      ))}
                    </colgroup>
                    <thead>
                      <tr>
                        {["기능", "작업", "UI 버전", "완료율", "완료", "거부", "확인 불가"].map((label) => (
                          <th scope="col" key={label}>
                            {label}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.groups.map((row) => (
                        <tr key={`${row.feature_id}|${row.action}|${row.ui_version}`}>
                          <th scope="row">
                            <ExpandableCellText value={titles.get(row.feature_id) ?? row.feature_id} />
                          </th>
                          <td>{actionLabels[row.action]}</td>
                          <td>{row.ui_version || "버전 확인 불가"}</td>
                          <td>{actionSuccessRate(row)}</td>
                          <td>{row.success.toLocaleString("ko-KR")}</td>
                          <td>{row.rejected.toLocaleString("ko-KR")}</td>
                          <td>{row.unknown.toLocaleString("ko-KR")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p>
                  표에 생략된 유형: 완료 {data.other.success.toLocaleString("ko-KR")}건 · 거부{" "}
                  {data.other.rejected.toLocaleString("ko-KR")}건 · 확인 불가{" "}
                  {data.other.unknown.toLocaleString("ko-KR")}건
                </p>
              </>
            )}
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
