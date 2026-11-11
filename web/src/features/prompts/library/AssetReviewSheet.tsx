import { AssetHistory } from "./AssetHistory";
import { libraryNumber, libraryCost, libraryPercent } from "./library-model";
import { useAuth } from "@/app/auth/AuthProvider";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { useAssetReview, assertAssetReceipt, assertAssetStatus } from "./use-asset-review";
import { libraryError, libraryAssetSchema, projectLibrary } from "./library-model";
import { LibraryWriteNotice } from "./LibraryWriteNotice";
import { LibraryCopyButton } from "./LibraryCopyButton";
import { useLibraryQuery } from "./use-library-query";
import { readLibraryUsage } from "./library-api";
import { ClipboardCopy, Send } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { PanelFailure, PromptTable, type PromptColumn } from "@/features/prompts/library/prompt-parts";
import {
  assetStatusLabel,
  assetStatusTransitions,
  canSubmitAsset,
  type AssetStatusTransition,
} from "@/features/prompts/library/prompt-utils";
import { apiClient } from "@/shared/api/client";
import type { PromptAsset, PromptAssetHistoryEntry, PromptAssetUsageRow } from "@/shared/api/domains/prompts";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { useLibraryMutation, useLibraryBusy } from "./use-library-mutation";
import { formatDateTime } from "@/shared/utils/format";

const routeId = "prompts.library";
const writeHint = "admin:write 권한이 필요합니다.";

export function AssetReviewSheet({
  asset,
  canWrite: canEdit,
}: {
  asset: PromptAsset;
  canWrite: boolean;
}): React.JSX.Element {
  const busy = useLibraryBusy();
  const canWrite = canEdit && !busy;
  const { credentialPrefixes } = useAuth();
  const review = useAssetReview();
  const assetId = asset.id;
  const [pendingTransition, setPendingTransition] = useState<{
    asset: PromptAsset;
    transition: AssetStatusTransition;
  }>();
  const [pendingSubmit, setPendingSubmit] = useState<PromptAsset>();
  const [pendingRollback, setPendingRollback] = useState<{
    asset: PromptAsset;
    snapshot: PromptAssetHistoryEntry;
  }>();
  const actionTriggerRef = useRef<HTMLButtonElement | null>(null);

  const usage = useLibraryQuery({
    key: ["prompts", "asset-usage", assetId],
    enabled: assetId !== "",
    read: (prefixes, signal) => readLibraryUsage(assetId, prefixes, signal),
  });

  const usageRows = usage.data?.usage ?? [];

  const invalidates = [
    ["prompts", "assets"],
    ["prompts", "asset-selected", assetId],
    ["prompts", "asset-history", assetId],
    ["prompts", "asset-usage", assetId],
  ];

  const submitForReview = useLibraryMutation({
    prepare: review.current,
    validate: (result, expected: PromptAsset) => assertAssetStatus(result, expected.id, "pending"),
    mutate: (expected: PromptAsset) =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.submit, { id: expected.id }), {
        routeId,
        retryUnauthorized: false,
      }),
    invalidates,
    successMessage: "검토를 요청했습니다.",
    errorMessage: "검토를 요청하지 못했습니다.",
  });

  const decideReview = useLibraryMutation({
    prepare: async (value: { asset: PromptAsset; status: string; note: string }) => {
      await review.current(value.asset);
    },
    validate: (result, value) => assertAssetStatus(result, value.asset.id, value.status),
    mutate: (variables: { asset: PromptAsset; status: string; note: string }) =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.approve, { id: assetId }), {
        body: { status: variables.status, note: variables.note },
        routeId,
        retryUnauthorized: false,
      }),
    invalidates,
    successMessage: "검토 결과를 반영했습니다.",
    errorMessage: "검토 결과를 반영하지 못했습니다.",
  });

  const rollback = useLibraryMutation({
    prepare: async (value: { asset: PromptAsset; snapshot: PromptAssetHistoryEntry }) => {
      await review.rollback(value.asset, value.snapshot);
    },
    validate: (result, value) => {
      if (result.restored_from !== value.snapshot.version_num) throw libraryError("unknown");
      const template = result.template
        ? projectLibrary(libraryAssetSchema, result.template, credentialPrefixes)
        : undefined;
      const { name, category, description, body, tags } = value.snapshot;
      assertAssetReceipt(template, value.asset.id, {
        name,
        category,
        description,
        body,
        tags,
        status: value.asset.status,
        enabled: value.asset.enabled,
      });
    },
    mutate: (value: { asset: PromptAsset; snapshot: PromptAssetHistoryEntry }) =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.rollback, { id: assetId }), {
        body: { version: Number(value.snapshot.version_num) },
        routeId,
        retryUnauthorized: false,
      }),
    invalidates,
    successMessage: "이전 버전으로 복원했습니다.",
    errorMessage: "이전 버전으로 복원하지 못했습니다.",
  });

  const useAsset = useLibraryMutation({
    prepare: review.current,
    validate: (result, expected: PromptAsset) => {
      if (
        result.id !== expected.id ||
        typeof result.body !== "string" ||
        containsPotentialSecret(result.body, credentialPrefixes)
      )
        throw libraryError("unknown");
    },
    mutate: (expected: PromptAsset) =>
      apiClient.request(withPathParams(endpoints.domains.prompts.assets.use, { id: expected.id }), {
        routeId,
        retryUnauthorized: false,
      }),
    invalidates,
    errorMessage: "사용 기록 요청을 완료하지 못했습니다.",
    onSuccess: async (result, _expected, assertCurrent) => {
      assertCurrent();
      try {
        await navigator.clipboard.writeText(result.body ?? "");
      } catch {
        assertCurrent();
        toast.info("사용 기록을 요청했습니다. 복사는 실패했으므로 본문 복사 버튼을 이용하세요.");
        return;
      }
      assertCurrent();
      toast.success("본문을 복사하고 사용 기록을 요청했습니다.");
    },
  });

  const transitions = assetStatusTransitions(asset?.status);
  const usageColumns: ReadonlyArray<PromptColumn<PromptAssetUsageRow>> = [
    { id: "team", header: "팀", cell: (row) => row.team || "미지정" },
    {
      id: "calls",
      header: "호출수",
      cell: (row) => <span className="cell-number">{libraryNumber(row.calls)}</span>,
    },
    {
      id: "errors",
      header: "오류",
      cell: (row) =>
        Number(row.errors ?? 0) > 0 ? (
          <Badge tone="warning">{libraryNumber(row.errors)}</Badge>
        ) : (
          <span className="cell-number">{libraryNumber(row.errors)}</span>
        ),
    },
    {
      id: "cost",
      header: "비용",
      cell: (row) => <span className="cell-number">{libraryCost(row.cost_krw)}</span>,
    },
  ];

  return (
    <>
      {asset ? (
        <div className="page-stack prompt-library-detail">
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
                setPendingSubmit(asset);
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
                  setPendingTransition({ asset, transition });
                }}
              >
                {transition.label}
              </Button>
            ))}
            <Button
              disabled={!canWrite || asset.enabled !== true || useAsset.uncertain}
              title={asset.enabled ? undefined : "중지된 자산은 사용할 수 없습니다."}
              onClick={() => useAsset.mutate(asset)}
            >
              <ClipboardCopy aria-hidden="true" /> 복사 및 사용 기록 요청
            </Button>
          </div>

          <LibraryWriteNotice uncertain={useAsset.uncertain} />
          <KeyValueList
            items={[
              { label: "ID", value: asset.id, mono: true },
              { label: "상태", value: assetStatusLabel(asset.status) },
              {
                label: "사용 여부",
                value: asset.enabled === true ? "사용" : asset.enabled === false ? "중지" : "—",
              },
              { label: "분류", value: asset.category ?? "—" },
              { label: "태그", value: (asset.tags ?? []).join(", ") || "—" },
              { label: "설명", value: asset.description ?? "—" },
              { label: "노트", value: asset.note ?? "—" },
              { label: "승인자", value: asset.approved_by ?? "—" },
              { label: "승인 시각", value: formatDateTime(asset.approved_at) },
              { label: "최근 사용", value: formatDateTime(asset.last_used_at) },
              { label: "재사용 횟수", value: libraryNumber(asset.use_count) },
              { label: "성공률", value: libraryPercent(asset.success_rate) },
              { label: "평균 비용", value: libraryCost(asset.avg_cost_krw) },
              { label: "평균 지연", value: `${libraryNumber(asset.avg_latency_ms)} ms` },
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
              tableId="usage"
              caption="팀별 사용 현황"
              columns={usageColumns}
              rows={usageRows}
              loading={usage.isPending}
              emptyMessage="90일 내 이 자산으로 기록된 호출이 없습니다."
            />
          </section>

          <AssetHistory
            assetId={assetId}
            canWrite={canWrite}
            onRollback={(snapshot, trigger) => {
              actionTriggerRef.current = trigger;
              setPendingRollback({ asset, snapshot });
            }}
          />

          <section>
            <h3>프롬프트 본문</h3>
            <LibraryCopyButton value={asset.body ?? ""} />
            <p className="prompt-asset-body" tabIndex={0} role="region" aria-label="프롬프트 본문 내용">
              {asset.body || "본문이 없습니다."}
            </p>
          </section>
        </div>
      ) : null}

      <ConfirmDialog
        open={pendingSubmit !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingSubmit(undefined);
        }}
        returnFocusRef={actionTriggerRef}
        title="검토를 제출할까요?"
        description={`"${asset?.name ?? assetId}" 자산을 검토 대기 상태로 보내고 검토자에게 알립니다.`}
        confirmLabel="검토 제출"
        confirmDisabled={!canWrite || submitForReview.uncertain}
        onConfirm={async () => {
          if (pendingSubmit) await submitForReview.mutateAsync(pendingSubmit);
        }}
      >
        <LibraryWriteNotice uncertain={submitForReview.uncertain} />
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingTransition !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingTransition(undefined);
        }}
        returnFocusRef={actionTriggerRef}
        title={`이 자산을 ${pendingTransition?.transition.label ?? ""} 처리할까요?`}
        description={`"${asset?.name ?? assetId}" 자산의 상태가 바뀌며 변경 이력에 사유가 함께 남습니다.`}
        confirmLabel={pendingTransition?.transition.label ?? "확인"}
        tone={pendingTransition?.transition.tone ?? "primary"}
        confirmDisabled={!canWrite || decideReview.uncertain}
        requireReason
        onConfirm={async (reason) => {
          if (pendingTransition) {
            await decideReview.mutateAsync({
              asset: pendingTransition.asset,
              status: pendingTransition.transition.status,
              note: reason,
            });
          }
        }}
      >
        <LibraryWriteNotice uncertain={decideReview.uncertain} />
      </ConfirmDialog>

      <ConfirmDialog
        open={pendingRollback !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingRollback(undefined);
        }}
        returnFocusRef={actionTriggerRef}
        title="이전 버전으로 복원할까요?"
        description={`v${pendingRollback?.snapshot.version_num ?? ""}의 이름·분류·설명·본문·태그를 복원하고 복원된 내용을 새 버전으로 기록합니다. 검토 상태와 사용 여부는 유지됩니다.`}
        confirmLabel="복원"
        confirmDisabled={!canWrite || rollback.uncertain}
        onConfirm={async () => {
          if (pendingRollback !== undefined) await rollback.mutateAsync(pendingRollback);
        }}
      >
        <LibraryWriteNotice uncertain={rollback.uncertain} />
      </ConfirmDialog>
    </>
  );
}
