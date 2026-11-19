import { useLocation } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { rejectedSensitiveQuery } from "@/shared/security/app-route-query";
import { Button } from "@/shared/components/ui/Button";
import { Badge } from "@/shared/components/ui/Badge";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { TableStateCell } from "@/shared/data-table/TableStateCell";
import {
  featureTitles,
  statusTones,
  statusDisplay,
  roleDisplay,
  readOnlyDisplay,
} from "./console-rollout-display";
import type { ConsoleFeatureRow } from "./settings-utils";
import { ConsoleFeatureFilters } from "./ConsoleFeatureFilters";
import {
  consoleFilterKeys,
  consoleFilterReset,
  consoleSearchMessages as text,
  readConsoleFilters,
  filterConsoleFeatures,
  consoleReadonlyValue,
} from "./console-feature-search";

export function ConsoleFeatureTable({
  rows,
  pending,
  failed,
  onEdit,
}: {
  rows: readonly ConsoleFeatureRow[];
  pending: boolean;
  failed: boolean;
  onEdit: (row: ConsoleFeatureRow, trigger: HTMLElement) => void;
}) {
  const { credentialPrefixes } = useAuth();
  const location = useLocation();
  const [params, update] = useSearchState();
  const filter = readConsoleFilters(params, credentialPrefixes);
  const rejected = consoleFilterKeys.some((key) => rejectedSensitiveQuery(location.state, key));
  if (rejected || !filter.valid)
    return (
      <InlineNotice tone="warning" title="기능별 전환 상태">
        <p>{text.invalidRoute}</p>
        <Button onClick={() => update(consoleFilterReset)}>{text.reset}</Button>
      </InlineNotice>
    );
  const visible = filterConsoleFeatures(rows, filter);
  return (
    <SectionCard
      title="기능별 전환 상태"
      headingLevel={2}
      description="화면마다 기존 화면 유지·미리보기·정식 전환과 대상 역할, 배포 비율을 조정합니다."
    >
      <ConsoleFeatureFilters filter={filter} update={update} />
      <p role="status">
        {pending
          ? "콘솔 전환 설정을 불러오는 중입니다."
          : failed && rows.length === 0
            ? "조회 실패로 기능 수를 확인할 수 없습니다."
            : `등록된 기능 ${rows.length.toLocaleString("ko-KR")}개 · 조건에 맞는 기능 ${visible.length.toLocaleString("ko-KR")}개`}
      </p>
      <p className="muted">
        현재 조회한 전환 설정의 목록입니다. 쓰기 차단 설정과 실제 사용자 권한은 다를 수 있으며, 정식
        상태만으로 운영 검증 완료를 뜻하지 않습니다.
      </p>
      <div className="data-table-scroll" role="region" aria-label="기능별 전환 상태 표" tabIndex={0}>
        <table className="data-table">
          <caption className="sr-only">기능별 콘솔 전환 상태</caption>
          <thead>
            <tr>
              <th scope="col">기능</th>
              <th scope="col">상태</th>
              <th scope="col">미리보기 역할</th>
              <th scope="col">배포 비율</th>
              <th scope="col">읽기 전용</th>
              <th scope="col" className="data-table-action-heading">
                작업
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 ? (
              <tr>
                <TableStateCell colSpan={6}>
                  {pending
                    ? "콘솔 전환 설정을 불러오는 중입니다."
                    : failed
                      ? "전환 설정을 불러오지 못했습니다. 위 안내에서 다시 조회하세요."
                      : rows.length === 0
                        ? "전환 설정을 제공하는 기능이 없습니다."
                        : "조회 조건에 맞는 기능이 없습니다. 조건을 바꾸거나 초기화하세요."}
                </TableStateCell>
              </tr>
            ) : (
              visible.map((row) => {
                const status = row.status?.value ?? "";
                return (
                  <tr key={row.featureId}>
                    <th scope="row">
                      <span className="settings-key-cell">
                        <span>{featureTitles.get(row.featureId) ?? row.featureId}</span>
                        <small className="mono">{row.featureId}</small>
                      </span>
                    </th>
                    <td>
                      {status ? (
                        <span className="settings-key-cell">
                          <Badge tone={statusTones[status] ?? "muted"}>{statusDisplay(status)}</Badge>
                          <small className="mono">{status}</small>
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>{roleDisplay(row.roles?.value)}</td>
                    <td className="cell-number">
                      {row.rollout?.value === undefined ? "—" : `${row.rollout.value}%`}
                    </td>
                    <td>
                      {consoleReadonlyValue(row) === "unknown"
                        ? "확인 불가"
                        : readOnlyDisplay(row.readonly?.value)}
                    </td>
                    <td className="data-table-action-cell">
                      <Button
                        size="small"
                        variant="ghost"
                        aria-label={`${featureTitles.get(row.featureId) ?? row.featureId} 전환 설정 편집`}
                        onClick={(event) => {
                          onEdit(row, event.currentTarget);
                        }}
                      >
                        편집
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
