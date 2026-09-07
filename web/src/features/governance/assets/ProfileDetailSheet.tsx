import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera } from "lucide-react";
import { useRef, useState, type RefObject } from "react";

import { BadgeList, PanelFailure, ScoreBars } from "@/features/governance/reports/report-parts";
import { riskTone } from "@/features/governance/reports/report-window";
import { apiClient } from "@/shared/api/client";
import {
  personalizationProfileEndpoint,
  type ProfileCount,
  type ProfileSnapshot,
} from "@/shared/api/domains/governance-reports";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { createDataTableColumnHelper } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

interface SnapshotRow {
  id: string;
  created_at: string;
  requests: number;
  total_cost_krw: number;
  success_rate: number;
}

/** Snapshots store the profile as a JSON string; a malformed row must not break the table. */
function snapshotRows(snapshots: readonly ProfileSnapshot[]): SnapshotRow[] {
  return snapshots.map((snapshot, index) => {
    let parsed: Record<string, unknown> = {};
    try {
      const value: unknown = JSON.parse(snapshot.profile || "{}");
      if (value && typeof value === "object") parsed = value as Record<string, unknown>;
    } catch {
      parsed = {};
    }
    const numberOf = (key: string): number => (typeof parsed[key] === "number" ? parsed[key] : 0);
    return {
      id: snapshot.id || `snapshot-${index}`,
      created_at: snapshot.created_at,
      requests: numberOf("requests"),
      total_cost_krw: numberOf("total_cost_krw"),
      success_rate: numberOf("success_rate"),
    };
  });
}

function topKeys(items: readonly ProfileCount[]): readonly string[] {
  return items.slice(0, 5).map((item) => `${item.key} (${formatNumber(item.requests)})`);
}

function signed(value: number, digits = 0): string {
  const text = formatNumber(value, digits);
  return value > 0 ? `+${text}` : text;
}

export function ProfileDetailSheet({
  onClose,
  returnFocusRef,
  userId,
  window: reportWindow,
}: {
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  userId: string;
  window: string;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const snapshotTriggerRef = useRef<HTMLButtonElement>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const queryKey = ["governance", "personal-profile", userId, reportWindow];

  const detail = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      apiClient.request(personalizationProfileEndpoint(userId), {
        query: { window: reportWindow },
        signal,
        routeId: "governance.assets",
      }),
  });

  // `snapshot=1` is a GET with a side effect, so it only ever runs from this button.
  const snapshot = useMutationFeedback({
    mutate: () =>
      apiClient.request(personalizationProfileEndpoint(userId), {
        query: { window: reportWindow, snapshot: "1" },
        routeId: "governance.assets",
      }),
    invalidates: [queryKey],
    successMessage: "현재 프로필을 스냅샷으로 저장했습니다.",
    errorMessage: "스냅샷을 저장하지 못했습니다.",
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["governance", "personalization"] });
    },
  });

  const profile = detail.data?.profile;
  const drift = detail.data?.drift;
  const rows = snapshotRows(detail.data?.snapshots ?? []);
  const column = createDataTableColumnHelper<SnapshotRow>();
  const snapshotColumns = column.columns([
    column.accessor((row) => row.created_at, {
      id: "created_at",
      header: "생성 시각",
      cell: ({ row }) => formatDateTime(row.original.created_at),
    }),
    column.accessor((row) => row.requests, {
      id: "requests",
      header: "요청",
      cell: ({ row }) => <span className="cell-number">{formatNumber(row.original.requests)}</span>,
    }),
    column.accessor((row) => row.total_cost_krw, {
      id: "cost",
      header: "총비용",
      cell: ({ row }) => <span className="cell-number">{formatKRW(row.original.total_cost_krw)}</span>,
    }),
    column.accessor((row) => row.success_rate, {
      id: "success_rate",
      header: "성공률",
      cell: ({ row }) => <span className="cell-number">{formatPercent(row.original.success_rate)}</span>,
    }),
  ]);

  return (
    <Sheet
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="wide"
      returnFocusRef={returnFocusRef}
      title={`개인화 프로필 · ${userId}`}
      description="최근 기간의 AI 사용 패턴과 스냅샷 대비 변화입니다. 원문 프롬프트·SQL·응답은 포함되지 않습니다."
      footer={
        <Button
          ref={snapshotTriggerRef}
          variant="primary"
          onClick={() => setConfirmOpen(true)}
          disabled={snapshot.isPending || detail.isPending}
        >
          <Camera aria-hidden="true" /> 현재 상태 스냅샷
        </Button>
      }
    >
      <div className="gov-detail-grid">
        {detail.isError ? (
          <PanelFailure error={detail.error} label="개인화 프로필" onRetry={() => void detail.refetch()} />
        ) : null}
        {detail.isPending ? <p role="status">프로필을 불러오는 중입니다.</p> : null}

        {profile ? (
          <>
            <SectionCard
              headingLevel={3}
              title="핵심 지표"
              actions={
                <Badge tone={riskTone(profile.risk_score)}>위험 {formatNumber(profile.risk_score)}</Badge>
              }
            >
              <KeyValueList
                columns={2}
                items={[
                  { label: "사용자", value: profile.user_id || userId, mono: true },
                  { label: "팀 / 역할", value: `${profile.team || "-"} / ${profile.role || "-"}` },
                  { label: "요청 수", value: formatNumber(profile.requests) },
                  { label: "총 비용", value: formatKRW(profile.total_cost_krw) },
                  { label: "요청당 평균", value: formatKRW(profile.avg_cost_per_request) },
                  { label: "평균 지연", value: `${formatNumber(profile.avg_latency_ms)}ms` },
                  {
                    label: "성공률 / 오류율",
                    value: `${formatPercent(profile.success_rate)} / ${formatPercent(profile.error_rate)}`,
                  },
                  {
                    label: "캐시 / Text2SQL / MCP",
                    value: `${formatPercent(profile.cache_rate)} / ${formatPercent(profile.text2sql_usage_rate)} / ${formatPercent(profile.mcp_usage_rate)}`,
                  },
                  {
                    label: "distinct 모델 / 지문",
                    value: `${formatNumber(profile.distinct_models)} / ${formatNumber(profile.distinct_prompt_fingerprints)}`,
                  },
                  { label: "요약", value: profile.summary },
                ]}
              />
              <ScoreBars
                max={100}
                data={[
                  {
                    label: "캐시 활용",
                    value: profile.cache_rate * 100,
                    display: formatPercent(profile.cache_rate),
                  },
                  {
                    label: "Text2SQL",
                    value: profile.text2sql_usage_rate * 100,
                    display: formatPercent(profile.text2sql_usage_rate),
                  },
                  {
                    label: "MCP",
                    value: profile.mcp_usage_rate * 100,
                    display: formatPercent(profile.mcp_usage_rate),
                  },
                ]}
              />
            </SectionCard>

            <SectionCard headingLevel={3} title="선호 패턴">
              <KeyValueList
                columns={2}
                items={[
                  { label: "선호 작업", value: <BadgeList items={topKeys(profile.top_task_types)} /> },
                  { label: "선호 모델", value: <BadgeList items={topKeys(profile.top_models)} /> },
                  { label: "선호 언어", value: <BadgeList items={topKeys(profile.top_languages)} /> },
                  {
                    label: "자주 쓰는 MCP 도구",
                    value: <BadgeList items={topKeys(profile.top_mcp_tools)} />,
                  },
                ]}
              />
            </SectionCard>
          </>
        ) : null}

        <SectionCard
          headingLevel={3}
          title="스냅샷 추세 (drift)"
          description="가장 최근 두 스냅샷 사이의 변화입니다."
        >
          {drift?.has_baseline ? (
            <KeyValueList
              columns={2}
              items={[
                { label: "구간", value: `${formatDateTime(drift.from)} → ${formatDateTime(drift.to)}` },
                { label: "요청 변화", value: signed(drift.requests_delta) },
                { label: "총비용 변화", value: `${signed(drift.cost_delta_krw)} KRW` },
                { label: "요청당 평균 변화", value: `${signed(drift.avg_cost_delta_krw, 2)} KRW` },
                { label: "성공률 변화", value: `${signed(drift.success_rate_delta * 100, 1)}%p` },
                {
                  label: "대표 모델",
                  value: `${drift.top_model_from || "-"} → ${drift.top_model_to || "-"}${drift.top_model_changed ? " (변경)" : ""}`,
                },
                {
                  label: "주요 작업",
                  value: `${drift.top_task_from || "-"} → ${drift.top_task_to || "-"}${drift.top_task_changed ? " (변경)" : ""}`,
                },
                { label: "신호", value: <BadgeList items={drift.flags} tone="warning" /> },
              ]}
            />
          ) : (
            <p className="gov-note">
              추세 계산에는 스냅샷이 2개 이상 필요합니다. 시점을 두고 “현재 상태 스냅샷”을 여러 번 실행하세요.
            </p>
          )}
        </SectionCard>

        <SectionCard headingLevel={3} title="스냅샷 이력">
          <DataTable
            caption={`${userId} 프로필 스냅샷 이력`}
            columns={snapshotColumns}
            data={rows}
            getRowId={(row) => row.id}
            loading={detail.isPending}
            emptyMessage="스냅샷이 없습니다."
          />
        </SectionCard>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        returnFocusRef={snapshotTriggerRef}
        title="현재 상태를 스냅샷으로 저장할까요?"
        description="현재 프로필을 시점 기록으로 저장하고 감사 로그를 남깁니다."
        confirmLabel="스냅샷 저장"
        onConfirm={() => snapshot.mutateAsync(undefined)}
      />
    </Sheet>
  );
}
