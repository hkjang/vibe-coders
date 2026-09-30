import { useSyncExternalStore } from "react";

import { CostGuardDialog } from "./CostGuardDialog";
import { costGuardDescription, costGuardException } from "./cost-guard-state";
import { useCostGuard } from "./use-cost-guard";
import { PanelFailure } from "./governance-parts";
import { tokenStore } from "@/shared/auth/token-store";
import { CostGuardContractNotice } from "@/shared/components/form/CostGuardContractNotice";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatCostGuardThreshold } from "@/shared/utils/cost-guard";

export function CostGuardSection({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  // Security transitions dispose the editor and its late callbacks. Ordinary
  // refresh never remounts the baseline or the dirty form.
  return <CostGuardSession key={epoch} canWrite={canWrite} epoch={epoch} />;
}

function CostGuardSession({ canWrite, epoch }: { canWrite: boolean; epoch: number }): React.JSX.Element {
  const editor = useCostGuard(canWrite, epoch);
  const { query, confirmed, target } = editor;
  return (
    <SectionCard
      title="예상 비용 보호"
      description={costGuardDescription}
      actions={
        <Badge
          tone={
            !confirmed ? "warning" : confirmed.enabled && confirmed.threshold_krw > 0 ? "success" : "muted"
          }
        >
          {!confirmed
            ? "설정 미확인"
            : confirmed.enabled && confirmed.threshold_krw > 0
              ? "사용 중"
              : "비용 검사 제한 없음"}
        </Badge>
      }
    >
      <p>{costGuardException}</p>
      <CostGuardContractNotice />
      <KeyValueList
        items={[
          {
            label: "보호 사용",
            value: confirmed ? (confirmed.enabled ? "사용" : "사용 안 함") : "확인되지 않음",
          },
          {
            label: "요청당 임계값",
            value: confirmed ? formatCostGuardThreshold(confirmed.threshold_krw) : "확인되지 않음",
          },
        ]}
      />
      {query.isError ? (
        <PanelFailure
          error={query.error}
          hasData={false}
          label="비용 보호 설정"
          onRetry={() => void query.refetch()}
        />
      ) : editor.supported && !confirmed ? (
        <p role="status">
          {query.isFetching || query.isPending
            ? "비용 보호 설정을 불러오는 중입니다."
            : "설정 조회가 필요합니다. 사용 여부와 임계값을 확인한 뒤 수정할 수 있습니다."}
        </p>
      ) : null}
      {editor.committed && !confirmed ? (
        <InlineNotice tone="warning" title="설정 저장은 완료됐습니다.">
          후속 조회를 확인하지 못했거나 진행 중입니다. 저장을 다시 전송하지 말고 현재 설정을 다시 조회하세요.
        </InlineNotice>
      ) : null}
      <div className="governance-actions">
        <Button disabled={query.isFetching || editor.pending} onClick={() => void query.refetch()}>
          비용 보호 설정 새로고침
        </Button>
        <Button
          variant="primary"
          disabled={!canWrite || !confirmed || editor.pending || Boolean(target)}
          title={
            !canWrite
              ? "설정 변경 권한(admin:write)이 필요합니다."
              : !confirmed
                ? "현재 설정을 먼저 확인하세요."
                : undefined
          }
          onClick={(event) => editor.open(event.currentTarget)}
        >
          비용 보호 설정 수정
        </Button>
      </div>
      {target ? (
        <CostGuardDialog key={target.instance} target={target} editor={editor} canWrite={canWrite} />
      ) : null}
    </SectionCard>
  );
}
