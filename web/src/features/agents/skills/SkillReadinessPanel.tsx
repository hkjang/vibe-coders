import { useQuery } from "@tanstack/react-query";

import { severityTone, skillStatusLabels } from "@/features/agents/skills/skill-form";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatNumber } from "@/shared/utils/format";

interface SkillReadinessPanelProps {
  canWrite: boolean;
  onPromote: (toStatus: string) => void;
  skillName: string;
  writeDisabledReason: string;
}

/** Production-readiness checklist behind the promotion gate (`/admin/skill-studio/readiness`). */
export function SkillReadinessPanel({
  canWrite,
  onPromote,
  skillName,
  writeDisabledReason,
}: SkillReadinessPanelProps): React.JSX.Element {
  const readiness = useQuery({
    queryKey: ["agents", "skills", skillName, "readiness"],
    enabled: skillName !== "",
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.skills.studioReadiness, {
        query: { name: skillName },
        signal,
        routeId: "agents.skills",
      }),
  });

  if (skillName === "") {
    return (
      <SectionCard title="승격 준비도" headingLevel={3}>
        <EmptyState
          title="Skill을 선택하세요."
          description="후보를 채택했거나 이미 존재하는 Skill을 고르면 승격 게이트 점검 결과를 확인할 수 있습니다."
        />
      </SectionCard>
    );
  }

  if (readiness.isPending) {
    return (
      <SectionCard title="승격 준비도" headingLevel={3}>
        <p role="status">승격 준비도를 불러오는 중입니다.</p>
      </SectionCard>
    );
  }

  if (readiness.isError) {
    return (
      <SectionCard title="승격 준비도" headingLevel={3}>
        <InlineNotice
          tone="danger"
          title="승격 준비도를 불러오지 못했습니다."
          actions={
            <Button size="small" onClick={() => void readiness.refetch()}>
              다시 시도
            </Button>
          }
        >
          {safeAppErrorMessage(readiness.error, "승격 준비도를 불러오지 못했습니다.")}
        </InlineNotice>
      </SectionCard>
    );
  }

  const data = readiness.data;
  const nextStatus = data?.next_status ?? "";

  return (
    <SectionCard
      title={`승격 준비도 · ${data?.name ?? skillName}`}
      headingLevel={3}
      description="필수 점검을 모두 통과해야 프로덕션으로 승격할 수 있습니다."
      actions={
        nextStatus ? (
          <Button
            variant="primary"
            size="small"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDisabledReason}
            onClick={() => onPromote(nextStatus)}
          >
            {skillStatusLabels[nextStatus] ?? nextStatus}으로 승격
          </Button>
        ) : null
      }
    >
      <KeyValueList
        columns={3}
        items={[
          {
            label: "현재 상태",
            value: skillStatusLabels[data?.status ?? ""] ?? data?.status ?? "—",
          },
          {
            label: "프로덕션 준비",
            value: (
              <Badge tone={data?.production_ready ? "success" : "warning"}>
                {data?.production_ready ? "준비 완료" : "미충족"}
              </Badge>
            ),
          },
          {
            label: "보안 스캔",
            value: (
              <Badge tone={severityTone(data?.scan?.max_severity)}>
                {data?.scan?.max_severity || "clean"}
              </Badge>
            ),
          },
          ...(data?.fitness_required
            ? [
                {
                  label: "적합성 근거",
                  value: `${formatNumber(data.fitness_passing ?? 0)} / ${formatNumber(data.fitness_threshold ?? 0)}`,
                },
              ]
            : []),
        ]}
      />

      <ul className="agents-checklist" aria-label="승격 게이트 점검 결과">
        {(data?.checks ?? []).map((check) => (
          <li key={check.key ?? check.label} data-ok={String(check.ok !== false)}>
            <span className="agents-checklist-copy">
              <strong>
                {check.label ?? check.key ?? "점검"}
                {check.required ? " (필수)" : ""}
              </strong>
              <small>
                {check.ok === false ? "미충족 · " : "충족 · "}
                {check.detail ?? ""}
              </small>
            </span>
          </li>
        ))}
      </ul>

      {(data?.scan?.findings ?? []).length > 0 ? (
        <ul className="agents-checklist" aria-label="보안 스캔 발견 사항">
          {(data?.scan?.findings ?? []).map((finding, index) => (
            <li key={`${finding.category ?? ""}-${index}`} data-ok={String(finding.severity !== "high")}>
              <span className="agents-checklist-copy">
                <strong>
                  <Badge tone={severityTone(finding.severity)}>{finding.severity ?? "—"}</Badge>{" "}
                  {finding.category ?? "—"}
                </strong>
                <small>{finding.detail ?? ""}</small>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <InlineNotice tone="info" title="Chat 테스트는 별도 화면에서">
        승격 마법사의 Chat 테스트 단계는 Chat 테스트 화면(`/admin#/chat-test`)에서 진행하고, 결과를 적합성
        근거로 남긴 뒤 이 화면에서 승격하세요.
      </InlineNotice>
    </SectionCard>
  );
}
