import { useRef, useState } from "react";
import { z } from "zod";

import { PanelFailure, ReadOnlyNotice } from "@/features/text2sql/overview/text2sql-presentation";
import { clip, writeDisabledTitle } from "@/features/text2sql/overview/text2sql-labels";
import { text2sqlInvalidations, text2sqlRouteId } from "@/features/text2sql/overview/use-text2sql-queries";
import { apiClient } from "@/shared/api/client";
import type { Text2SQLMiners, Text2SQLSavedReport } from "@/shared/api/domains/text2sql";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatNumber, formatRelative } from "@/shared/utils/format";

type ReportCandidate = Text2SQLMiners["report_candidates"][number];

const scheduleFormSchema = z.object({
  interval: z
    .string()
    .trim()
    .refine((value) => value === "" || /^\d+(\.\d+)?(ms|s|m|h)$/u.test(value), {
      message: "24h, 30m 처럼 양수와 단위(ms/s/m/h)로 입력하세요.",
    }),
  enabled: z.boolean(),
  deliver_mattermost: z.boolean(),
});
type ScheduleFormValues = z.infer<typeof scheduleFormSchema>;

const promoteFormSchema = z.object({
  name: z.string().trim().min(1, "리포트 이름을 입력하세요."),
});
type PromoteFormValues = z.infer<typeof promoteFormSchema>;

const approvalTones: Record<string, "danger" | "info" | "muted" | "success" | "warning"> = {
  approved: "success",
  pending: "warning",
  rejected: "danger",
};

interface Text2SqlReportTabProps {
  canWrite: boolean;
  miners: Text2SQLMiners | undefined;
  minersError: unknown;
  minersLoading: boolean;
  onRetryMiners: () => void;
  onRetryReports: () => void;
  reports: readonly Text2SQLSavedReport[];
  reportsError: unknown;
  reportsLoading: boolean;
}

export function Text2SqlReportTab({
  canWrite,
  miners,
  minersError,
  minersLoading,
  onRetryMiners,
  onRetryReports,
  reports,
  reportsError,
  reportsLoading,
}: Text2SqlReportTabProps): React.JSX.Element {
  const [scheduleTarget, setScheduleTarget] = useState<Text2SQLSavedReport | undefined>();
  const [reportToDelete, setReportToDelete] = useState("");
  const [promoteTarget, setPromoteTarget] = useState<ReportCandidate | undefined>();
  const rowTriggerRef = useRef<HTMLElement | null>(null);

  const scheduleForm = useZodForm<ScheduleFormValues, ScheduleFormValues>(scheduleFormSchema, {
    interval: "",
    enabled: false,
    deliver_mattermost: false,
  });
  const promoteForm = useZodForm<PromoteFormValues, PromoteFormValues>(promoteFormSchema, { name: "" });

  const saveSchedule = useMutationFeedback({
    mutate: (variables: ScheduleFormValues & { id: string }) =>
      apiClient.request(endpoints.domains.text2sql.reports.schedule, {
        body: variables,
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.reports,
    successMessage: "리포트 스케줄을 저장했습니다.",
  });
  const removeReport = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(endpoints.domains.text2sql.reports.remove, {
        query: { id },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.reports,
    successMessage: "저장 리포트를 삭제했습니다.",
  });
  const promote = useMutationFeedback({
    mutate: (variables: { name: string; question: string; sql: string }) =>
      apiClient.request(endpoints.domains.text2sql.promote, {
        body: { target: "report", ...variables },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.reports,
    successMessage: "반복 질문을 저장 리포트로 승격했습니다.",
  });

  const reportColumn = createDataTableColumnHelper<Text2SQLSavedReport>();
  const reportColumns = reportColumn.columns([
    reportColumn.accessor((row) => row.name, {
      id: "name",
      header: "리포트",
      cell: ({ row }) => (
        <div className="t2s-cell-stack">
          <strong>{row.original.name}</strong>
          <span className="truncate">{clip(row.original.question, 60)}</span>
        </div>
      ),
    }),
    reportColumn.accessor((row) => row.schedule_interval, {
      id: "schedule",
      header: "스케줄",
      cell: ({ row }) => (
        <div className="badge-list">
          {row.original.schedule_enabled && row.original.schedule_interval ? (
            <Badge tone="success">{row.original.schedule_interval}</Badge>
          ) : (
            <Badge tone="muted">수동</Badge>
          )}
          {row.original.deliver_mattermost ? <Badge tone="info">Mattermost</Badge> : null}
        </div>
      ),
    }),
    reportColumn.accessor((row) => row.visibility, {
      id: "visibility",
      header: "공유 · 승인",
      cell: ({ row }) => (
        <div className="badge-list">
          <Badge tone={row.original.visibility === "team" ? "info" : "muted"}>
            {row.original.visibility === "team" ? `팀 ${row.original.team || ""}`.trim() : "개인"}
          </Badge>
          {row.original.approval_status && row.original.approval_status !== "none" ? (
            <Badge tone={approvalTones[row.original.approval_status] ?? "muted"}>
              {row.original.approval_status}
            </Badge>
          ) : null}
        </div>
      ),
    }),
    reportColumn.accessor((row) => row.last_run_at, {
      id: "last_run",
      header: "최근 실행",
      cell: ({ getValue }) => (getValue() ? formatRelative(getValue()) : "—"),
    }),
    reportColumn.display({
      id: "actions",
      header: "동작",
      cell: ({ row }) => (
        <div className="table-actions">
          <Button
            size="small"
            disabled={!canWrite}
            title={writeDisabledTitle(canWrite)}
            onClick={(event) => {
              rowTriggerRef.current = event.currentTarget;
              scheduleForm.reset({
                interval: row.original.schedule_interval,
                enabled: row.original.schedule_enabled,
                deliver_mattermost: row.original.deliver_mattermost,
              });
              setScheduleTarget(row.original);
            }}
          >
            스케줄
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={!canWrite}
            title={writeDisabledTitle(canWrite)}
            onClick={(event) => {
              rowTriggerRef.current = event.currentTarget;
              setReportToDelete(row.original.id);
            }}
          >
            삭제
          </Button>
        </div>
      ),
    }),
  ]) as Array<DataTableColumn<Text2SQLSavedReport>>;

  const candidateColumn = createDataTableColumnHelper<ReportCandidate>();
  const candidateColumns = candidateColumn.columns([
    candidateColumn.accessor((row) => row.question, {
      id: "question",
      header: "반복 질문",
      cell: ({ getValue }) => <span className="truncate">{clip(getValue(), 70)}</span>,
    }),
    candidateColumn.accessor((row) => row.count, {
      id: "count",
      header: "횟수",
      cell: ({ getValue }) => <span className="cell-number">{formatNumber(getValue())}</span>,
    }),
    candidateColumn.accessor((row) => row.recommended_product, {
      id: "product",
      header: "추천 산출물",
      cell: ({ getValue }) => <Badge tone="info">{getValue() || "report"}</Badge>,
    }),
    candidateColumn.accessor((row) => row.last_seen, {
      id: "last_seen",
      header: "최근",
      cell: ({ getValue }) => (getValue() ? formatRelative(getValue()) : "—"),
    }),
    candidateColumn.display({
      id: "actions",
      header: "동작",
      cell: ({ row }) => (
        <Button
          size="small"
          disabled={!canWrite}
          title={writeDisabledTitle(canWrite)}
          onClick={(event) => {
            rowTriggerRef.current = event.currentTarget;
            promoteForm.reset({ name: clip(row.original.question, 40) });
            setPromoteTarget(row.original);
          }}
        >
          리포트로 승격
        </Button>
      ),
    }),
  ]) as Array<DataTableColumn<ReportCandidate>>;

  const glossaryCandidates = miners?.glossary_candidates ?? [];

  return (
    <div className="t2s-stack">
      <ReadOnlyNotice canWrite={canWrite} />

      <SectionCard
        title="저장 리포트 (스케줄 실행)"
        description="반복 질문을 승격한 리포트입니다. 팀 공유 승인은 팀 화면에서 처리하며 여기서는 상태만 표시합니다."
      >
        {reportsError ? (
          <PanelFailure
            error={reportsError}
            hasData={reports.length > 0}
            label="저장 리포트"
            onRetry={onRetryReports}
          />
        ) : null}
        <DataTable
          caption="Text2SQL 저장 리포트"
          columns={reportColumns}
          data={reports}
          loading={reportsLoading}
          getRowId={(row) => row.id}
          emptyMessage="저장 리포트가 없습니다. 아래 반복 질문을 '리포트로 승격'하면 여기에 표시됩니다."
        />
      </SectionCard>

      <SectionCard
        title="인사이트 — 반복 질문 리포트 후보"
        description="최근 30일 동안 3회 이상 반복된 질문입니다."
      >
        {minersError ? (
          <PanelFailure
            error={minersError}
            hasData={(miners?.report_candidates.length ?? 0) > 0}
            label="반복 질문 후보"
            onRetry={onRetryMiners}
          />
        ) : null}
        <DataTable
          caption="반복 질문 리포트 후보"
          columns={candidateColumns}
          data={miners?.report_candidates ?? []}
          loading={minersLoading}
          getRowId={(row, index) => `${row.question}-${index}`}
          emptyMessage="반복 질문 후보가 없습니다. (최근 30일, 3회 이상)"
        />
      </SectionCard>

      <SectionCard
        title="인사이트 — 업무 용어 후보"
        description="질문에서 자주 등장한 단어입니다. 권한·용어 탭에서 사전으로 등록할 수 있습니다."
      >
        {glossaryCandidates.length === 0 ? (
          <EmptyState
            title="용어 후보가 없습니다."
            description="Text2SQL 질문이 쌓이면 자주 쓰인 업무 용어가 여기에 모입니다."
          />
        ) : (
          <ul className="badge-list t2s-term-candidates">
            {glossaryCandidates.map((candidate) => (
              <li key={candidate.term}>
                <Badge tone="muted">
                  {candidate.term} ×{formatNumber(candidate.count)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <FormDialog
        open={scheduleTarget !== undefined}
        onOpenChange={(next) => {
          if (!next) setScheduleTarget(undefined);
        }}
        form={scheduleForm}
        returnFocusRef={rowTriggerRef}
        title={`리포트 스케줄 — ${scheduleTarget?.name ?? ""}`}
        description="주기를 비우거나 실행을 끄면 수동 실행만 가능합니다."
        onSubmit={async (values) => {
          if (!scheduleTarget) return;
          await saveSchedule.mutateAsync({ ...values, id: scheduleTarget.id });
          setScheduleTarget(undefined);
        }}
      >
        <FormField
          label="실행 주기"
          description="예: 24h, 30m"
          error={scheduleForm.formState.errors.interval?.message}
        >
          {(control) => <Input {...control} {...scheduleForm.register("interval")} placeholder="24h" />}
        </FormField>
        <Checkbox {...scheduleForm.register("enabled")} label="주기마다 자동 실행" />
        <Checkbox {...scheduleForm.register("deliver_mattermost")} label="실행 결과를 Mattermost로 전달" />
      </FormDialog>

      <FormDialog
        open={promoteTarget !== undefined}
        onOpenChange={(next) => {
          if (!next) setPromoteTarget(undefined);
        }}
        form={promoteForm}
        returnFocusRef={rowTriggerRef}
        title="반복 질문을 리포트로 승격"
        description="질문과 예시 SQL이 저장 리포트로 등록됩니다."
        submitLabel="승격"
        onSubmit={async (values) => {
          if (!promoteTarget) return;
          await promote.mutateAsync({
            name: values.name,
            question: promoteTarget.question,
            sql: promoteTarget.sample_sql,
          });
          setPromoteTarget(undefined);
        }}
      >
        <FormField label="리포트 이름" required error={promoteForm.formState.errors.name?.message}>
          {(control) => <Input {...control} {...promoteForm.register("name")} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={reportToDelete !== ""}
        onOpenChange={(next) => {
          if (!next) setReportToDelete("");
        }}
        returnFocusRef={rowTriggerRef}
        tone="danger"
        title="저장 리포트 삭제"
        description="삭제하면 이 리포트의 스케줄 실행도 함께 중단됩니다."
        confirmLabel="삭제"
        onConfirm={async () => {
          await removeReport.mutateAsync(reportToDelete);
          setReportToDelete("");
        }}
      />
    </div>
  );
}
