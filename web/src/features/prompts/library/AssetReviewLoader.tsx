import type { RefObject } from "react";
import { Sheet } from "@/shared/components/ui/Sheet";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { useLibraryQuery } from "./use-library-query";
import { readLibraryAssets } from "./library-api";
import { AssetReviewSheet } from "./AssetReviewSheet";
import { PanelFailure } from "./prompt-parts";

export function AssetReviewLoader({
  id,
  canWrite,
  onOpenChange,
  returnFocusRef,
}: {
  id: string;
  canWrite: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  // The existing API lists all assets. Detail lookup must not inherit list filters.
  const selected = useLibraryQuery({
    key: ["prompts", "asset-selected", id],
    read: (prefixes, signal) => readLibraryAssets({}, prefixes, signal),
  });
  const asset = selected.data?.assets.find((row) => row.id === id);
  return (
    <Sheet
      open
      onOpenChange={onOpenChange}
      returnFocusRef={returnFocusRef}
      size="wide"
      title={asset?.name || "프롬프트 자산"}
      description="자산 정보, 사용 현황과 변경 이력을 확인합니다. 변경 작업은 실행 전에 최신 내용과 다시 비교합니다."
    >
      {selected.isError ? (
        <PanelFailure
          error={selected.error}
          hasData={Boolean(asset)}
          label="자산 상세"
          onRetry={() => void selected.refetch()}
        />
      ) : null}
      {asset ? (
        <AssetReviewSheet asset={asset} canWrite={canWrite && !selected.isError} />
      ) : selected.isPending ? (
        <p role="status">자산 상세를 불러오는 중입니다.</p>
      ) : !selected.isError ? (
        <EmptyState
          title="자산을 찾을 수 없습니다."
          description="삭제되었거나 현재 조회 범위에 없는 자산입니다. 목록에서 다른 자산을 선택하세요."
        />
      ) : null}
    </Sheet>
  );
}
