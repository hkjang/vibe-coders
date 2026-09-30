import { History } from "lucide-react";
import type { CompareAccess } from "./use-compare-access";
import type { useComparisonConsole } from "./use-comparison-console";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

export function ChatComparisonHistory({
  history,
  refresh,
  access,
}: {
  history: ReturnType<typeof useComparisonConsole>["history"];
  refresh: () => void;
  access: CompareAccess;
}) {
  return (
    <SectionCard
      title="최근 실행 이력"
      description="서버에 저장된 비교 실행입니다. 응답 수신과 이력 저장 여부는 별도로 확인하세요."
      actions={
        <Button
          size="small"
          variant="ghost"
          disabled={!access.readAllowed || history.isFetching}
          onClick={refresh}
        >
          <History aria-hidden="true" /> 새로고침
        </Button>
      }
    >
      {!access.readAllowed ? (
        <InlineNotice tone="warning" title="실행 원문 조회 권한이 없습니다.">
          {access.readReason}
        </InlineNotice>
      ) : history.isPending ? (
        <p role="status">실행 이력을 확인하고 있습니다.</p>
      ) : history.isError ? (
        <InlineNotice tone="warning" title="이력을 불러오지 못했습니다.">
          {safeAppErrorMessage(history.error, "권한 또는 네트워크 상태를 확인하세요.")}
          {isAppError(history.error) && history.error.requestId ? (
            <span className="request-id"> 요청 ID: {history.error.requestId}</span>
          ) : null}
        </InlineNotice>
      ) : history.data.runs.length === 0 ? (
        <EmptyState
          title="저장된 비교 실행이 없습니다."
          description="비교 실행 후 새로고침으로 저장된 이력을 확인하세요."
        />
      ) : (
        <div className="data-table-scroll" tabIndex={0} aria-label="최근 멀티 모델 실행 표 영역">
          <table className="data-table">
            <caption className="sr-only">최근 멀티 모델 비교 실행</caption>
            <thead>
              <tr>
                <th scope="col">제목</th>
                <th scope="col">모델</th>
                <th scope="col">성공/실패</th>
                <th scope="col">실행자</th>
                <th scope="col">시각</th>
              </tr>
            </thead>
            <tbody>
              {history.data.runs.map((item) => (
                <tr key={item.id}>
                  <td>{item.title || item.id}</td>
                  <td className="cell-number">{formatNumber(item.model_count ?? 0)}</td>
                  <td className="cell-number">
                    {formatNumber(item.success ?? 0)} / {formatNumber(item.failed ?? 0)}
                  </td>
                  <td>{item.created_by || "-"}</td>
                  <td>{formatDateTime(item.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
