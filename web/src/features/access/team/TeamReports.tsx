import { useState } from "react";
import type { TeamReportRow } from "@/shared/api/domains/team.schemas";
import { statusLabel, statusTone } from "@/features/access/access-format";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Button } from "@/shared/components/ui/Button";
import { Badge } from "@/shared/components/ui/Badge";
import { Select } from "@/shared/components/ui/Select";
import { FormField } from "@/shared/components/form/FormField";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime } from "@/shared/utils/format";
import { useTeamReportsQuery } from "./use-team-queries";
import { useTeamReportDecision } from "./use-team-report-decision";
import { useAuth } from "@/app/auth/AuthProvider";
import { validTeamText, teamError, safeTeamMessage } from "./team-model";
import { TeamQueryPanel } from "./team-ui";
import { TeamTable } from "./TeamTable";

export function TeamReports() {
  const { credentialPrefixes } = useAuth();
  const query = useTeamReportsQuery(),
    decision = useTeamReportDecision();
  const [params, update] = useSearchState();
  const status = ["pending", "approved"].includes(params.get("report_status") ?? "")
    ? (params.get("report_status") ?? "")
    : "";
  const [review, setReview] = useState<{ report: TeamReportRow; action: "approve" | "reject" }>();
  const { returnFocusRef, remember } = useReturnFocus();
  const rows = query.data?.reports ?? [];
  const pending = rows.filter((row) => row.approval_status === "pending").length;
  const disabled = !decision.access.allowed || decision.busy || decision.uncertain;
  return (
    <SectionCard
      title="팀 공용 리포트"
      description={"받은 목록의 승인 대기 " + pending + "건 · 승인하면 같은 팀에 공개됩니다."}
    >
      {decision.uncertain ? (
        <InlineNotice tone="warning" title="처리 결과를 먼저 확인하세요.">
          리포트 목록과 감사 이력을 확인하고 페이지를 다시 열기 전에는 추가 결정을 실행할 수 없습니다.
        </InlineNotice>
      ) : null}
      <TeamQueryPanel query={query} label="팀 공용 리포트">
        <FormField label="리포트 승인 상태">
          {(control) => (
            <Select
              {...control}
              value={status}
              onChange={(event) => update({ report_status: event.target.value, reports_page: undefined })}
            >
              <option value="">전체</option>
              <option value="pending">승인 대기</option>
              <option value="approved">승인</option>
            </Select>
          )}
        </FormField>
        <TeamTable
          id="reports"
          caption="팀 공용 리포트"
          rows={rows.filter((row) => !status || row.approval_status === status)}
          getRowId={(row) => row.id}
          columns={[
            { id: "name", header: "이름", value: (row) => row.name },
            {
              id: "status",
              header: "승인 상태",
              value: (row) => statusLabel(row.approval_status),
              cell: (row) => (
                <Badge tone={statusTone(row.approval_status)}>{statusLabel(row.approval_status)}</Badge>
              ),
            },
            {
              id: "kind",
              header: "종류",
              value: (row) =>
                (
                  ({
                    report: "리포트",
                    dashboard_card: "대시보드 카드",
                    text2sql: "자연어 SQL",
                    sql: "SQL",
                    question: "질문",
                  }) as Record<string, string>
                )[row.kind] ??
                (row.kind || "미지정"),
            },
            { id: "schema", header: "스키마", value: (row) => row.schema_name },
            { id: "creator", header: "작성자", value: (row) => row.created_by },
            {
              id: "created",
              header: "생성 시각",
              value: (row) => row.created_at,
              cell: (row) => formatDateTime(row.created_at),
            },
            {
              id: "last",
              header: "최근 실행",
              value: (row) => row.last_run_at,
              cell: (row) => (row.last_run_at ? formatDateTime(row.last_run_at) : "—"),
            },
            {
              id: "actions",
              header: "작업",
              cell: (row) => (
                <div className="table-actions">
                  {(["approve", "reject"] as const).map((action) => (
                    <Button
                      key={action}
                      size="small"
                      variant={action === "approve" ? "primary" : "danger"}
                      disabled={
                        disabled || row.approval_status !== "pending" || !/^[a-f0-9]{64}$/u.test(row.revision)
                      }
                      title={
                        row.approval_status !== "pending"
                          ? "승인 대기 중인 리포트만 결정할 수 있습니다."
                          : !row.revision
                            ? "최신 서버의 검토 정보가 필요합니다."
                            : decision.access.reason
                      }
                      onClick={(event) => {
                        remember(event.currentTarget);
                        setReview({ report: row, action });
                      }}
                    >
                      {action === "approve" ? "승인" : "반려"}
                    </Button>
                  ))}
                </div>
              ),
            },
          ]}
        />
      </TeamQueryPanel>
      <ConfirmDialog
        errorFormatter={safeTeamMessage}
        key={review ? review.report.id + review.action : "closed"}
        open={Boolean(review)}
        onOpenChange={(open) => {
          if (!open) setReview(undefined);
        }}
        returnFocusRef={returnFocusRef}
        requireReason
        scrollBody
        confirmDisabled={disabled}
        title={review?.action === "reject" ? "리포트 반려" : "리포트 승인"}
        confirmLabel={review?.action === "reject" ? "반려" : "승인"}
        tone={review?.action === "reject" ? "danger" : "primary"}
        description={
          review?.action === "reject"
            ? "리포트를 반려하면 작성자가 다시 제출해야 합니다."
            : "리포트 내용을 확인한 뒤 선택한 팀에 공개합니다. 실행 직전 최신 내용과 비교합니다."
        }
        onConfirm={async (reason) => {
          if (!validTeamText(reason, credentialPrefixes, 500)) throw teamError("invalid");
          if (review) await decision.mutateAsync({ ...review, reason });
        }}
      >
        {review ? (
          <div className="team-report-review">
            <p>
              대상 팀 <strong>{review.report.team}</strong> · {review.report.name}
            </p>
            <p>
              스키마 {review.report.schema_name || "미지정"} · 작성자 {review.report.created_by || "미지정"}
            </p>
            <p>
              예약{" "}
              {review.report.schedule_enabled === undefined
                ? "미확인"
                : review.report.schedule_enabled
                  ? review.report.schedule_interval || "사용"
                  : "중지"}{" "}
              · Mattermost 알림{" "}
              {review.report.deliver_mattermost === undefined
                ? "미확인"
                : review.report.deliver_mattermost
                  ? "사용"
                  : "중지"}
            </p>
            <p className="access-note">
              비밀정보로 판단된 내용은 숨깁니다. 사유는 500자 이내이며 감사 이력에 기록됩니다.
            </p>
            <h3>질문</h3>
            <pre tabIndex={0} aria-label="리포트 질문">
              {review.report.question || "저장된 질문 없음"}
            </pre>
            <h3>SQL</h3>
            <pre tabIndex={0} aria-label="리포트 SQL">
              {review.report.sql || "저장된 SQL 없음"}
            </pre>
            {!decision.access.allowed ? (
              <InlineNotice tone="warning">{decision.access.reason}</InlineNotice>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </SectionCard>
  );
}
