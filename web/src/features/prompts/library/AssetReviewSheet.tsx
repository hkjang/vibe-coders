import { useQuery } from "@tanstack/react-query";
import { ClipboardCopy, History, Send } from "lucide-react";
import { useMemo, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";

import { PanelFailure, PromptTable, type PromptColumn } from "@/features/prompts/library/prompt-parts";
import {
  assetHistoryActionLabel,
  assetStatusLabel,
  assetStatusTransitions,
  canSubmitAsset,
  diffPromptBodies,
  type AssetStatusTransition,
} from "@/features/prompts/library/prompt-utils";
import { apiClient } from "@/shared/api/client";
import type { PromptAsset, PromptAssetHistoryEntry, PromptAssetUsageRow } from "@/shared/api/domains/prompts";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { CopyButton } from "@/shared/components/ui/CopyButton";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { Sheet } from "@/shared/components/ui/Sheet";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import {
  formatDateTime,
  formatKRW,
  formatNumber,
  formatPercent,
  formatRelative,
} from "@/shared/utils/format";

const routeId = "prompts.library";
const writeHint = "admin:write 권한이 필요합니다.";

interface AssetReviewSheetProps {
  asset: PromptAsset | undefined;
  canWrite: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

/**
 * Review workspace for one prompt asset: metadata, per-team usage, the version
 * log with diff and rollback, and the submit/approve/reject transitions.
 */
export function AssetReviewSheet({
  asset,
  canWrite,
  onOpenChange,
  returnFocusRef,
}: AssetReviewSheetProps): React.JSX.Element {
  const assetId = asset?.id ?? "";
  const [pendingTransition, setPendingTransition] = useState<AssetStatusTransition | undefined>();
  const [submitOpen, setSubmitOpen] = useState(false);
  const [pendingRollback, setPendingRollback] = useState<number | undefined>();
  // Keyed by asset so switching assets drops the open diff without an effect.
  const [diffSelection, setDiffSelection] = useState<{ assetId: string; version: number } | undefined>();
  const actionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const diffAgainst = diffSelection?.assetId === assetId ? diffSelection.version : undefined;

  const history = useQuery({
    queryKey: ["prompts", "asset-history", assetId],
    enabled: assetId !== "",
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.history, { id: assetId }), {
        signal,
        routeId,
      }),
  });

  const usage = useQuery({
    queryKey: ["prompts", "asset-usage", assetId],
    enabled: assetId !== "",
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.usage, { id: assetId }), {
        signal,
        routeId,
      }),
  });

  const historyRows = useMemo(() => history.data?.history ?? [], [history.data]);
  const versions = useMemo(() => historyRows.filter((entry) => entry.has_snapshot), [historyRows]);
  const usageRows = usage.data?.usage ?? [];

  const invalidates = [
    ["prompts", "assets"],
    ["prompts", "asset-history", assetId],
    ["prompts", "asset-usage", assetId],
  ];

  const submitForReview = useMutationFeedback({
    mutate: () =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.submit, { id: assetId }), {
        routeId,
      }),
    invalidates,
    successMessage: "검토를 요청했습니다.",
    errorMessage: "검토를 요청하지 못했습니다.",
  });

  const decideReview = useMutationFeedback({
    mutate: (variables: { status: string; note: string }) =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.approve, { id: assetId }), {
        body: { status: variables.status, note: variables.note },
        routeId,
      }),
    invalidates,
    successMessage: "검토 결과를 반영했습니다.",
    errorMessage: "검토 결과를 반영하지 못했습니다.",
  });

  const rollback = useMutationFeedback({
    mutate: (version: number) =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.rollback, { id: assetId }), {
        body: { version },
        routeId,
      }),
    invalidates,
    successMessage: "이전 버전으로 복원했습니다.",
    errorMessage: "이전 버전으로 복원하지 못했습니다.",
  });

  // `/use` records the usage server-side and returns the body, which stays in
  // memory and on the clipboard only — never in the URL, storage or a toast.
  const useAsset = useMutationFeedback({
    mutate: () =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.use, { id: assetId }), { routeId }),
    invalidates,
    errorMessage: "사용 기록을 남기지 못했습니다.",
    onSuccess: (result) => {
      const body = result.body ?? "";
      void navigator.clipboard
        ?.writeText(body)
        .then(() => toast.success("본문을 복사하고 사용 기록을 남겼습니다."))
        .catch(() => toast.success("사용 기록을 남겼습니다. 본문은 아래에서 직접 복사하세요."));
    },
  });

  const transitions = assetStatusTransitions(asset?.status);
  const currentVersion = versions[0]?.version_num;

  const diffLines = useMemo(() => {
    if (diffAgainst === undefined) return [];
    const index = versions.findIndex((entry) => entry.version_num === diffAgainst);
    const newer = versions[index];
    const older = versions[index + 1];
    if (!newer || !older) return [];
    return diffPromptBodies(older.body ?? "", newer.body ?? "");
  }, [diffAgainst, versions]);

  const usageColumns: ReadonlyArray<PromptColumn<PromptAssetUsageRow>> = [
    { id: "team", header: "팀", cell: (row) => row.team || "미지정" },
    {
      id: "calls",
      header: "호출수",
      cell: (row) => <span className="cell-number">{formatNumber(row.calls)}</span>,
    },
    {
      id: "errors",
      header: "오류",
      cell: (row) =>
        Number(row.errors ?? 0) > 0 ? (
          <Badge tone="warning">{formatNumber(row.errors)}</Badge>
        ) : (
          <span className="cell-number">0</span>
        ),
    },
    {
      id: "cost",
      header: "비용",
      cell: (row) => <span className="cell-number">{formatKRW(row.cost_krw)}</span>,
    },
  ];

  const versionColumns: ReadonlyArray<PromptColumn<PromptAssetHistoryEntry>> = [
    {
      id: "version",
      header: "버전",
      cell: (row) => <strong>{`v${formatNumber(row.version_num)}`}</strong>,
    },
    {
      id: "action",
      header: "작업",
      cell: (row) => (
        <span>
          {assetHistoryActionLabel(row.action)}
          {row.note ? <span className="prompt-history-meta"> ({row.note})</span> : null}
        </span>
      ),
    },
    { id: "actor", header: "작성자", cell: (row) => row.actor || "—" },
    { id: "created_at", header: "시각", cell: (row) => formatDateTime(row.created_at) },
    {
      id: "actions",
      header: "비교 / 복원",
      cell: (row) => {
        const index = versions.findIndex((entry) => entry.version_num === row.version_num);
        const hasOlder = index >= 0 && versions[index + 1] !== undefined;
        const isCurrent = row.version_num === currentVersion;
        return (
          <span className="prompt-filter-actions">
            {hasOlder ? (
              <Button
                size="small"
                variant="ghost"
                aria-label={`v${formatNumber(row.version_num)} 이전 버전과 비교`}
                onClick={() => setDiffSelection({ assetId, version: Number(row.version_num) })}
              >
                비교
              </Button>
            ) : null}
            {isCurrent ? (
              <span className="prompt-history-meta">현재</span>
            ) : (
              <Button
                size="small"
                disabled={!canWrite}
                title={canWrite ? undefined : writeHint}
                aria-label={`v${formatNumber(row.version_num)}으로 복원`}
                onClick={(event) => {
                  actionTriggerRef.current = event.currentTarget;
                  setPendingRollback(Number(row.version_num));
                }}
              >
                <History aria-hidden="true" /> 이 버전으로 복원
              </Button>
            )}
          </span>
        );
      },
    },
  ];

  return (
    <>
      <Sheet
        open={asset !== undefined}
        onOpenChange={onOpenChange}
        returnFocusRef={returnFocusRef}
        size="wide"
        title={asset?.name ?? "프롬프트 자산"}
        description="자산의 메타데이터, 사용 현황, 버전 이력과 검토 상태를 확인하고 처리합니다."
      >
        {asset ? (
          <div className="page-stack">
            <div className="prompt-filter-actions" role="group" aria-label="검토 동작">
              <Button
                variant="primary"
                disabled={!canWrite || !canSubmitAsset(asset.status)}
                title={
                  !canWrite
                    ? writeHint
                    : canSubmitAsset(asset.status)
                      ? undefined
                      : "초안 상태에서만 검토를 제출할 수 있습니다."
                }
                onClick={(event) => {
                  actionTriggerRef.current = event.currentTarget;
                  setSubmitOpen(true);
                }}
              >
                <Send aria-hidden="true" /> 검토 제출
              </Button>
              {transitions.map((transition) => (
                <Button
                  key={transition.status}
                  variant={transition.tone === "danger" ? "danger" : "primary"}
                  disabled={!canWrite}
                  title={canWrite ? undefined : writeHint}
                  onClick={(event) => {
                    actionTriggerRef.current = event.currentTarget;
                    setPendingTransition(transition);
                  }}
                >
                  {transition.label}
                </Button>
              ))}
              <Button
                disabled={!asset.enabled}
                title={asset.enabled ? undefined : "중지된 자산은 사용할 수 없습니다."}
                onClick={() => useAsset.mutate()}
              >
                <ClipboardCopy aria-hidden="true" /> 사용 기록 남기고 복사
              </Button>
            </div>

            <KeyValueList
              items={[
                { label: "ID", value: asset.id, mono: true },
                { label: "상태", value: assetStatusLabel(asset.status) },
                { label: "사용 여부", value: asset.enabled === false ? "중지" : "사용" },
                { label: "분류", value: asset.category ?? "—" },
                { label: "태그", value: (asset.tags ?? []).join(", ") || "—" },
                { label: "설명", value: asset.description ?? "—" },
                { label: "노트", value: asset.note ?? "—" },
                { label: "승인자", value: asset.approved_by ?? "—" },
                { label: "승인 시각", value: formatDateTime(asset.approved_at) },
                { label: "최근 사용", value: formatDateTime(asset.last_used_at) },
                { label: "재사용 횟수", value: formatNumber(asset.use_count) },
                { label: "성공률", value: formatPercent(asset.success_rate) },
                { label: "평균 비용", value: formatKRW(asset.avg_cost_krw) },
                { label: "평균 지연", value: `${formatNumber(asset.avg_latency_ms)} ms` },
              ]}
            />

            <section>
              <h3>사용처 (팀별 · 90일)</h3>
              {usage.isError ? (
                <PanelFailure
                  error={usage.error}
                  hasData={Boolean(usage.data)}
                  label="팀별 사용 현황"
                  onRetry={() => void usage.refetch()}
                />
              ) : null}
              <PromptTable
                caption="팀별 사용 현황"
                columns={usageColumns}
                rows={usageRows}
                loading={usage.isPending}
                emptyMessage="90일 내 이 자산으로 기록된 호출이 없습니다."
              />
            </section>

            <section>
              <h3>버전 이력</h3>
              {history.isError ? (
                <PanelFailure
                  error={history.error}
                  hasData={Boolean(history.data)}
                  label="버전 이력"
                  onRetry={() => void history.refetch()}
                />
              ) : null}
              <PromptTable
                caption="버전 이력"
                columns={versionColumns}
                rows={versions}
                loading={history.isPending}
                emptyMessage="기록된 버전이 없습니다."
              />
              {diffAgainst !== undefined ? (
                <>
                  <h4>{`v${diffAgainst} 이전 버전과의 차이`}</h4>
                  <pre className="prompt-diff" aria-label={`v${diffAgainst} 본문 차이`}>
                    {diffLines.length === 0
                      ? "본문 변경이 없습니다."
                      : diffLines.map((line) => (
                          <span
                            key={line.key}
                            className={line.tone === "added" ? "prompt-diff-added" : "prompt-diff-removed"}
                          >
                            {`${line.tone === "added" ? "+" : "-"} ${line.text}`}
                          </span>
                        ))}
                  </pre>
                </>
              ) : null}
            </section>

            <section>
              <h3>변경 이력</h3>
              {historyRows.length === 0 ? (
                <EmptyState
                  title="변경 이력이 없습니다."
                  description="자산을 수정하거나 검토를 진행하면 이곳에 기록이 쌓입니다."
                />
              ) : (
                <ol className="prompt-history-log">
                  {historyRows.map((entry) => (
                    <li key={entry.id} className="prompt-history-entry">
                      <strong>{assetHistoryActionLabel(entry.action)}</strong>
                      {entry.has_snapshot ? <Badge>{`v${formatNumber(entry.version_num)}`}</Badge> : null}
                      {entry.from_status || entry.to_status ? (
                        <span className="prompt-history-meta">
                          {`${assetStatusLabel(entry.from_status) || "—"} → ${assetStatusLabel(entry.to_status) || "—"}`}
                        </span>
                      ) : null}
                      {entry.note ? <span className="prompt-history-meta">{entry.note}</span> : null}
                      <span className="prompt-history-meta">
                        {`${entry.actor || "system"} · ${formatRelative(entry.created_at)}`}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section>
              <h3>프롬프트 본문</h3>
              <CopyButton value={asset.body ?? ""} label="본문 복사" />
              <p className="prompt-asset-body">{asset.body || "본문이 없습니다."}</p>
            </section>
          </div>
        ) : null}
      </Sheet>

      <ConfirmDialog
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        returnFocusRef={actionTriggerRef}
        title="검토를 제출할까요?"
        description={`"${asset?.name ?? assetId}" 자산을 검토 대기 상태로 보내고 검토자에게 알립니다.`}
        confirmLabel="검토 제출"
        onConfirm={async () => {
          await submitForReview.mutateAsync();
        }}
      />

      <ConfirmDialog
        open={pendingTransition !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingTransition(undefined);
        }}
        returnFocusRef={actionTriggerRef}
        title={`이 자산을 ${pendingTransition?.label ?? ""} 처리할까요?`}
        description={`"${asset?.name ?? assetId}" 자산의 상태가 바뀌며 변경 이력에 사유가 함께 남습니다.`}
        confirmLabel={pendingTransition?.label ?? "확인"}
        tone={pendingTransition?.tone ?? "primary"}
        requireReason
        onConfirm={async (reason) => {
          if (pendingTransition) {
            await decideReview.mutateAsync({ status: pendingTransition.status, note: reason });
          }
        }}
      />

      <ConfirmDialog
        open={pendingRollback !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingRollback(undefined);
        }}
        returnFocusRef={actionTriggerRef}
        title="이전 버전으로 복원할까요?"
        description={`v${pendingRollback ?? ""} 본문으로 되돌립니다. 현재 본문은 새 버전으로 기록됩니다.`}
        confirmLabel="복원"
        onConfirm={async () => {
          if (pendingRollback !== undefined) await rollback.mutateAsync(pendingRollback);
        }}
      />
    </>
  );
}
