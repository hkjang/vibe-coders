import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { z } from "zod";

import { formatSignedRatio, severityTone } from "@/features/access/access-format";
import { QueryNotice } from "@/features/access/access-ui";
import { meKeys, useMeSkillsQuery } from "@/features/access/me/use-me-queries";
import { apiClient } from "@/shared/api/client";
import type {
  RecommendationFeedbackBody,
  SkillAccessRequestBody,
  SkillFeedbackBody,
} from "@/shared/api/domains/access";
import type { MeSkill } from "@/shared/api/domains/access.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatKRW, formatNumber } from "@/shared/utils/format";

const access = endpoints.domains.access;
const routeId = "me.home";

const requestSchema = z.object({ reason: z.string().min(1, "신청 사유를 입력하세요.") });
type RequestForm = z.infer<typeof requestSchema>;

// The server rejects anything outside 1..5 with `bad_rating`.
const feedbackSchema = z.object({
  rating: z.enum(["1", "2", "3", "4", "5"]),
  comment: z.string(),
});
type FeedbackForm = z.infer<typeof feedbackSchema>;

const ratingLabels: Readonly<Record<string, string>> = {
  "1": "1 · 매우 불만족",
  "2": "2 · 불만족",
  "3": "3 · 보통",
  "4": "4 · 만족",
  "5": "5 · 매우 만족",
};

export function MeSkillsTab(): React.JSX.Element {
  const skills = useMeSkillsQuery(true);
  const [recommendationsRequested, setRecommendationsRequested] = useState(false);
  // Every GET regenerates and replaces the caller's recommendations, so this is
  // deliberately opt-in rather than loaded with the tab.
  const recommendations = useQuery({
    queryKey: meKeys.recommendations,
    enabled: recommendationsRequested,
    queryFn: ({ signal }) => apiClient.request(access.me.recommendations, { signal, routeId }),
  });

  const [requesting, setRequesting] = useState<MeSkill | undefined>();
  const [rating, setRating] = useState<MeSkill | undefined>();
  const rowTrigger = useRef<HTMLElement>(null);

  const requestForm = useZodForm<RequestForm, RequestForm>(requestSchema, { reason: "" });
  const feedbackForm = useZodForm<FeedbackForm, FeedbackForm>(feedbackSchema, {
    rating: "5",
    comment: "",
  });

  const requestAccess = useMutationFeedback({
    mutate: ({ name, body }: { name: string; body: SkillAccessRequestBody }) =>
      apiClient.request(withPathParams(access.me.requestSkillAccess, { name }), { body, routeId }),
    invalidates: [meKeys.skills],
    successMessage: "접근 요청이 접수되었습니다.",
  });
  const skillFeedback = useMutationFeedback({
    mutate: ({ name, body }: { name: string; body: SkillFeedbackBody }) =>
      apiClient.request(withPathParams(access.me.skillFeedback, { name }), { body, routeId }),
    invalidates: [meKeys.skills],
    successMessage: "평가를 남겼습니다.",
  });

  const feedback = useMutationFeedback({
    mutate: ({ id, body }: { id: string; body: RecommendationFeedbackBody }) =>
      apiClient.request(withPathParams(access.me.recommendationFeedback, { id }), { body, routeId }),
    invalidates: [meKeys.recommendations],
    successMessage: "의견을 반영했습니다.",
  });

  if (skills.isPending && !skills.data) return <LoadingState label="Skill 목록을 불러오는 중입니다." />;

  const available = skills.data?.available ?? [];
  const requestable = skills.data?.requestable ?? [];
  const recommendationRows = recommendations.data?.recommendations ?? [];

  return (
    <div className="access-stack">
      {skills.isError ? (
        <QueryNotice
          error={skills.error}
          hasData={Boolean(skills.data)}
          label="Skill 목록"
          onRetry={() => void skills.refetch()}
        />
      ) : null}

      <SectionCard title="사용 가능한 Skill" description="내 팀에 열려 있는 Skill과 최근 30일 성과입니다.">
        {available.length === 0 ? (
          <EmptyState
            title="사용 가능한 Skill이 없습니다."
            description="관리자가 Skill을 팀에 배포하면 여기에 나타납니다."
          />
        ) : (
          <ul className="access-list">
            {available.map((skill) => (
              <li key={skill.name}>
                <span className="access-list-title">
                  {skill.name}
                  <Badge tone={severityTone(skill.risk_level)}>{skill.risk_level || "위험도 미상"}</Badge>
                </span>
                <span className="access-list-detail">{skill.description}</span>
                <span className="access-inline-actions">
                  <span className="access-list-detail">
                    30일 실행 {formatNumber(skill.runs_30d)} · 성공률 {formatSignedRatio(skill.success_rate)}{" "}
                    · 사용자 {formatNumber(skill.users_30d)} · 만족도 {formatNumber(skill.satisfaction, 1)}
                  </span>
                  <Button
                    size="small"
                    onClick={(event) => {
                      rowTrigger.current = event.currentTarget;
                      feedbackForm.reset({ rating: "5", comment: "" });
                      setRating(skill);
                    }}
                  >
                    평가하기
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard title="요청 가능한 Skill" description="접근 권한을 신청해야 쓸 수 있는 Skill입니다.">
        {requestable.length === 0 ? (
          <EmptyState
            title="신청할 Skill이 없습니다."
            description="팀에 아직 열리지 않은 Skill이 생기면 여기에 표시됩니다."
          />
        ) : (
          <ul className="access-list">
            {requestable.map((skill) => (
              <li key={skill.name}>
                <span className="access-list-title">
                  {skill.name}
                  <Badge tone={severityTone(skill.risk_level)}>{skill.risk_level || "위험도 미상"}</Badge>
                </span>
                <span className="access-list-detail">{skill.description}</span>
                <span className="access-inline-actions">
                  <Button
                    size="small"
                    variant="primary"
                    onClick={(event) => {
                      rowTrigger.current = event.currentTarget;
                      requestForm.reset({ reason: "" });
                      setRequesting(skill);
                    }}
                  >
                    접근 신청
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="내 추천"
        description="비용과 품질을 개선할 수 있는 제안입니다. 불러올 때마다 최신 상태로 다시 계산됩니다."
        actions={
          <Button
            variant="primary"
            disabled={recommendations.isFetching}
            onClick={() => setRecommendationsRequested(true)}
          >
            {recommendations.isFetching ? "불러오는 중" : "추천 불러오기"}
          </Button>
        }
      >
        {!recommendationsRequested ? (
          <p className="access-note">'추천 불러오기'를 누르면 내 사용 패턴을 다시 분석해 제안을 만듭니다.</p>
        ) : recommendations.isError ? (
          <QueryNotice
            error={recommendations.error}
            hasData={Boolean(recommendations.data)}
            label="추천"
            onRetry={() => void recommendations.refetch()}
          />
        ) : recommendationRows.length === 0 ? (
          <EmptyState
            title="지금은 제안할 항목이 없습니다."
            description="사용량이 더 쌓이면 절감이나 품질 개선 제안을 만들어 드립니다."
          />
        ) : (
          <ul className="access-list">
            {recommendationRows.map((row) => (
              <li key={row.id}>
                <span className="access-list-title">
                  {row.title}
                  <Badge tone="info">{row.kind}</Badge>
                </span>
                <span className="access-list-detail">{row.detail}</span>
                <span className="access-inline-actions">
                  <span className="access-list-detail">예상 절감 {formatKRW(row.est_savings_krw)}</span>
                  <Button
                    size="small"
                    onClick={() => feedback.mutate({ id: row.id, body: { action: "adopted" } })}
                  >
                    적용함
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => feedback.mutate({ id: row.id, body: { action: "later" } })}
                  >
                    나중에
                  </Button>
                  <Button
                    size="small"
                    variant="ghost"
                    onClick={() => feedback.mutate({ id: row.id, body: { action: "dismissed" } })}
                  >
                    필요 없음
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <FormDialog
        form={requestForm}
        open={requesting !== undefined}
        onOpenChange={(open) => {
          if (!open) setRequesting(undefined);
        }}
        returnFocusRef={rowTrigger}
        title="Skill 접근 신청"
        description={`'${requesting?.name ?? ""}' Skill 사용 권한을 신청합니다. 사유는 승인 담당자에게 그대로 전달됩니다.`}
        submitLabel="신청"
        onSubmit={async (values) => {
          if (!requesting) return;
          await requestAccess.mutateAsync({ name: requesting.name, body: { reason: values.reason } });
          setRequesting(undefined);
        }}
      >
        <FormField label="신청 사유" required error={requestForm.formState.errors.reason?.message}>
          {(control) => <Textarea {...control} rows={3} {...requestForm.register("reason")} />}
        </FormField>
      </FormDialog>

      <FormDialog
        form={feedbackForm}
        open={rating !== undefined}
        onOpenChange={(open) => {
          if (!open) setRating(undefined);
        }}
        returnFocusRef={rowTrigger}
        title="Skill 평가"
        description={`'${rating?.name ?? ""}' Skill을 1~5점으로 평가합니다. 의견은 Skill 담당자가 확인합니다.`}
        submitLabel="평가 보내기"
        onSubmit={async (values) => {
          if (!rating) return;
          await skillFeedback.mutateAsync({
            name: rating.name,
            body: {
              rating: Number(values.rating),
              ...(values.comment ? { comment: values.comment } : {}),
            },
          });
          setRating(undefined);
        }}
      >
        <FormField label="점수" required>
          {(control) => (
            <Select {...control} {...feedbackForm.register("rating")}>
              {Object.entries(ratingLabels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        <FormField label="의견">
          {(control) => <Textarea {...control} rows={3} {...feedbackForm.register("comment")} />}
        </FormField>
      </FormDialog>
    </div>
  );
}
