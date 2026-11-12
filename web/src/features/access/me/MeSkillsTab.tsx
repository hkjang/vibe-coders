import { useRef, useState } from "react";
import { z } from "zod";
import { useAuth } from "@/app/auth/AuthProvider";
import { severityTone } from "@/features/access/access-format";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import type { MeSkill } from "@/shared/api/domains/me-console.schemas";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useMeSkillsQuery } from "./use-me-queries";
import { useMeSkillRequest, useMeSkillFeedback } from "./me-console-actions";
import { MeQueryContent, MePartial, MeOperationNotice } from "./me-console-ui";
import { meLabel, meNumber, mePercent, safeMeMessage, validMeText } from "./me-console-model";
import { MeRecommendations } from "./MeRecommendations";
import { MeTable, type MeColumn } from "./MeTable";

type SkillRow = MeSkill & { available: boolean };
export function MeSkillsTab() {
  const { credentialPrefixes } = useAuth();
  const query = useMeSkillsQuery(true);
  const [params, update] = useSearchState();
  const kind = ["available", "requestable"].find((value) => value === params.get("skill_kind")) ?? "all";
  const request = useMeSkillRequest(),
    feedback = useMeSkillFeedback();
  const [requesting, setRequesting] = useState<MeSkill>();
  const [rating, setRating] = useState<MeSkill>();
  const [requested, setRequested] = useState<ReadonlySet<string>>(new Set());
  const trigger = useRef<HTMLElement>(null);
  const requestSchema = z.object({
    reason: z
      .string()
      .trim()
      .min(1, "신청 사유를 입력하세요.")
      .max(500, "500자 이내로 입력하세요.")
      .refine((value) => validMeText(value, credentialPrefixes), "비밀값과 제어 문자는 입력할 수 없습니다."),
  });
  const feedbackSchema = z.object({
    rating: z.enum(["1", "2", "3", "4", "5"]),
    comment: z
      .string()
      .trim()
      .max(500, "500자 이내로 입력하세요.")
      .refine(
        (value) => !value || validMeText(value, credentialPrefixes),
        "비밀값과 제어 문자는 입력할 수 없습니다.",
      ),
  });
  const requestForm = useZodForm<z.input<typeof requestSchema>, z.output<typeof requestSchema>>(
    requestSchema,
    { reason: "" },
  );
  const feedbackForm = useZodForm<z.input<typeof feedbackSchema>, z.output<typeof feedbackSchema>>(
    feedbackSchema,
    { rating: "5", comment: "" },
  );
  const rows: SkillRow[] = [
    ...(query.data?.available ?? []).map((row) => ({ ...row, available: true })),
    ...(query.data?.requestable ?? []).map((row) => ({ ...row, available: false })),
  ].filter((row) => kind === "all" || row.available === (kind === "available"));
  const statsUnavailable = query.data?.partial_failures.includes("runs") ?? false;
  const feedbackUnavailable = query.data?.partial_failures.includes("feedback") ?? false;
  const columns: readonly MeColumn<SkillRow>[] = [
    { id: "name", header: "스킬", value: (row) => row.name },
    { id: "description", header: "설명", value: (row) => row.description },
    { id: "access", header: "접근", value: (row) => (row.available ? "사용 가능" : "신청 가능") },
    {
      id: "risk",
      header: "위험도",
      value: (row) => meLabel(row.risk_level),
      cell: (row) => <Badge tone={severityTone(row.risk_level)}>{meLabel(row.risk_level)}</Badge>,
    },
    { id: "runs", header: "30일 실행", value: (row) => (statsUnavailable ? undefined : row.runs_30d) },
    {
      id: "success",
      header: "성공률 (%)",
      value: (row) => (statsUnavailable || !row.runs_30d ? undefined : row.success_rate),
      cell: (row) => "성공률 " + mePercent(statsUnavailable || !row.runs_30d ? undefined : row.success_rate),
    },
    { id: "users", header: "사용자 수", value: (row) => (statsUnavailable ? undefined : row.users_30d) },
    {
      id: "rating",
      header: "만족도 (5점)",
      value: (row) => (feedbackUnavailable || !row.feedback_count ? undefined : row.satisfaction),
      cell: (row) => meNumber(feedbackUnavailable || !row.feedback_count ? undefined : row.satisfaction, 1),
    },
    {
      id: "actions",
      header: "작업",
      cell: (row) =>
        row.available ? (
          <Button
            size="small"
            disabled={feedback.disabled || query.isFetching}
            onClick={(event) => {
              trigger.current = event.currentTarget;
              feedbackForm.reset({ rating: "5", comment: "" });
              setRating(row);
            }}
          >
            평가하기
          </Button>
        ) : requested.has(row.name) ? (
          <span>이번 화면에서 신청 완료</span>
        ) : (
          <Button
            size="small"
            disabled={request.disabled || query.isFetching}
            onClick={(event) => {
              trigger.current = event.currentTarget;
              requestForm.reset({ reason: "" });
              setRequesting(row);
            }}
          >
            접근 신청
          </Button>
        ),
    },
  ];
  return (
    <div className="access-stack">
      {!request.access.allowed ? (
        <InlineNotice tone="info">
          읽기 전용입니다. 입력한 사유와 평가는 유지되며 전송은 할 수 없습니다.
        </InlineNotice>
      ) : null}
      <MeOperationNotice
        pending={request.pending || feedback.pending}
        uncertain={request.uncertain || feedback.uncertain}
      />
      <SectionCard
        title="내 팀의 스킬"
        description="스킬의 접근 가능 여부와 최근 30일 전체 사용자 실행 통계입니다. 만족도는 전체 평가 기준입니다."
      >
        <FormField label="접근 상태">
          {(control) => (
            <Select
              {...control}
              value={kind}
              onChange={(event) =>
                update({
                  skill_kind: event.target.value === "all" ? undefined : event.target.value,
                  skills_page: undefined,
                })
              }
            >
              <option value="all">전체</option>
              <option value="available">사용 가능한 스킬</option>
              <option value="requestable">신청 가능한 스킬</option>
            </Select>
          )}
        </FormField>
        <MeQueryContent query={query} label="스킬 목록">
          <MePartial failures={query.data?.partial_failures} />
          <MeTable
            id="skills"
            caption="내 팀 스킬"
            rows={rows}
            columns={columns}
            getRowId={(row) => row.name}
            loading={query.isFetching}
          />
        </MeQueryContent>
      </SectionCard>
      <MeRecommendations />
      <FormDialog
        form={requestForm}
        open={Boolean(requesting)}
        onOpenChange={(open) => {
          if (!open) setRequesting(undefined);
        }}
        returnFocusRef={trigger}
        title="스킬 접근 신청"
        description={`'${requesting?.name ?? ""}' 스킬의 접근을 신청합니다. 사유는 승인 담당자에게 전달됩니다. 비밀값을 입력하지 마세요.`}
        submitLabel="신청"
        submitDisabled={request.disabled}
        errorFormatter={safeMeMessage}
        scrollBody
        onSubmit={async (values) => {
          if (!requesting) return;
          const name = requesting.name;
          await request.execute({ name, reason: values.reason });
          setRequested((previous) => new Set([...previous, name]));
          setRequesting(undefined);
        }}
      >
        <FormField label="신청 사유" required error={requestForm.formState.errors.reason?.message}>
          {(control) => (
            <Textarea {...control} maxLength={500} rows={4} {...requestForm.register("reason")} />
          )}
        </FormField>
      </FormDialog>
      <FormDialog
        form={feedbackForm}
        open={Boolean(rating)}
        onOpenChange={(open) => {
          if (!open) setRating(undefined);
        }}
        returnFocusRef={trigger}
        title="스킬 평가"
        description={`'${rating?.name ?? ""}' 스킬을 평가합니다. 의견은 담당자에게 전달됩니다. 비밀값을 입력하지 마세요.`}
        submitLabel="평가 보내기"
        submitDisabled={feedback.disabled}
        errorFormatter={safeMeMessage}
        scrollBody
        onSubmit={async (values) => {
          if (!rating) return;
          await feedback.execute({
            name: rating.name,
            rating: Number(values.rating),
            comment: values.comment,
          });
          setRating(undefined);
        }}
      >
        <FormField label="점수" required>
          {(control) => (
            <Select {...control} {...feedbackForm.register("rating")}>
              {["1 · 매우 불만족", "2 · 불만족", "3 · 보통", "4 · 만족", "5 · 매우 만족"].map(
                (label, index) => (
                  <option key={label} value={index + 1}>
                    {label}
                  </option>
                ),
              )}
            </Select>
          )}
        </FormField>
        <FormField label="의견" error={feedbackForm.formState.errors.comment?.message}>
          {(control) => (
            <Textarea {...control} maxLength={500} rows={4} {...feedbackForm.register("comment")} />
          )}
        </FormField>
      </FormDialog>
    </div>
  );
}
