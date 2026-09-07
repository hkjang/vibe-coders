import { useQuery } from "@tanstack/react-query";
import { useState, type RefObject } from "react";

import {
  riskTone,
  skillRiskLabels,
  skillStatusLabels,
  statusTone,
} from "@/features/agents/skills/skill-form";
import { SkillPolicyTester } from "@/features/agents/skills/SkillPolicyTester";
import { apiClient } from "@/shared/api/client";
import type { Skill } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatDuration, formatKRW, formatNumber } from "@/shared/utils/format";

interface SkillDetailSheetProps {
  canWrite: boolean;
  onDelete: () => void;
  onEdit: () => void;
  onOpenChange: (open: boolean) => void;
  onPromote: () => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  skill: Skill | undefined;
  writeDisabledReason: string;
}

type DetailPanel = "runs" | "history" | "fitness" | "policy";

const panelLabels: Record<DetailPanel, string> = {
  runs: "실행 로그",
  history: "승격 이력",
  fitness: "적합성 근거",
  policy: "정책 시뮬레이션",
};

export function SkillDetailSheet({
  canWrite,
  onDelete,
  onEdit,
  onOpenChange,
  onPromote,
  open,
  returnFocusRef,
  skill,
  writeDisabledReason,
}: SkillDetailSheetProps): React.JSX.Element {
  const [panel, setPanel] = useState<DetailPanel | undefined>();
  const name = skill?.name ?? "";

  const runs = useQuery({
    queryKey: ["agents", "skills", name, "runs"],
    enabled: open && panel === "runs" && name !== "",
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.skills.runs, {
        query: { skill: name, limit: 50 },
        signal,
        routeId: "agents.skills",
      }),
  });

  const promotions = useQuery({
    queryKey: ["agents", "skills", name, "promotions"],
    enabled: open && panel === "history" && name !== "",
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.skills.promotions, {
        query: { skill: name, limit: 50 },
        signal,
        routeId: "agents.skills",
      }),
  });

  const fitness = useQuery({
    queryKey: ["agents", "skills", name, "fitness"],
    enabled: open && panel === "fitness" && name !== "",
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.skills.fitness, {
        query: { skill: name },
        signal,
        routeId: "agents.skills",
      }),
  });

  return (
    <Sheet
      description="Skill 정의와 실행 정책, 실행 로그와 승격 이력을 확인합니다."
      onOpenChange={(next) => {
        if (!next) setPanel(undefined);
        onOpenChange(next);
      }}
      open={open}
      returnFocusRef={returnFocusRef}
      size="wide"
      title={skill?.name ?? "Skill"}
    >
      {!skill ? (
        <EmptyState title="Skill을 찾을 수 없습니다." description="목록에서 다시 선택하세요." />
      ) : (
        <div className="agents-detail-stack">
          <KeyValueList
            items={[
              { label: "버전", value: skill.version, mono: true },
              {
                label: "상태",
                value: (
                  <Badge tone={statusTone(skill.status)}>
                    {skillStatusLabels[skill.status ?? ""] ?? skill.status ?? "—"}
                  </Badge>
                ),
              },
              {
                label: "위험 등급",
                value: (
                  <Badge tone={riskTone(skill.risk_level)}>
                    {skillRiskLabels[skill.risk_level ?? ""] ?? skill.risk_level ?? "—"}
                  </Badge>
                ),
              },
              { label: "책임자", value: skill.owner },
              { label: "설명", value: skill.description },
              { label: "허용 모델", value: skill.allowed_models || "제한 없음" },
              { label: "허용 도구", value: skill.allowed_tools || "제한 없음" },
              { label: "허용 팀", value: skill.allowed_teams || "전체" },
              {
                label: "일일 한도",
                value: skill.daily_limit ? formatNumber(skill.daily_limit) : "무제한",
              },
              { label: "수정", value: `${formatDateTime(skill.updated_at)} · ${skill.updated_by ?? ""}` },
            ]}
          />

          <div className="agents-detail-actions">
            <Button
              variant="primary"
              onClick={onPromote}
              disabled={!canWrite}
              title={canWrite ? undefined : writeDisabledReason}
            >
              승격
            </Button>
            <Button onClick={onEdit} disabled={!canWrite} title={canWrite ? undefined : writeDisabledReason}>
              편집
            </Button>
            {(Object.keys(panelLabels) as DetailPanel[]).map((id) => (
              <Button
                key={id}
                aria-expanded={panel === id}
                onClick={() => setPanel((current) => (current === id ? undefined : id))}
              >
                {panelLabels[id]}
              </Button>
            ))}
            <Button
              variant="danger"
              onClick={onDelete}
              disabled={!canWrite}
              title={canWrite ? undefined : writeDisabledReason}
            >
              삭제
            </Button>
          </div>
          {!canWrite ? (
            <InlineNotice tone="info" title="읽기 전용">
              {writeDisabledReason}
            </InlineNotice>
          ) : null}

          <SectionCard title="지침" headingLevel={3}>
            {skill.instructions ? (
              <pre className="mono" tabIndex={0} aria-label="Skill 지침">
                {skill.instructions}
              </pre>
            ) : (
              <EmptyState
                title="지침이 비어 있습니다."
                description="프로덕션 승격에는 지침이 반드시 필요합니다."
              />
            )}
          </SectionCard>

          {panel === "policy" ? <SkillPolicyTester skillName={skill.name} /> : null}

          {panel === "runs" ? (
            <SectionCard title="실행 로그" headingLevel={3}>
              {runs.isPending ? (
                <p role="status">실행 로그를 불러오는 중입니다.</p>
              ) : runs.isError ? (
                <InlineNotice
                  tone="danger"
                  title="실행 로그를 불러오지 못했습니다."
                  actions={
                    <Button size="small" onClick={() => void runs.refetch()}>
                      다시 시도
                    </Button>
                  }
                >
                  {safeAppErrorMessage(runs.error, "실행 로그를 불러오지 못했습니다.")}
                </InlineNotice>
              ) : (runs.data?.runs ?? []).length === 0 ? (
                <EmptyState title="실행 기록이 없습니다." />
              ) : (
                <div className="data-table-scroll" tabIndex={0} aria-label="Skill 실행 로그 표 영역">
                  <table className="data-table">
                    <caption className="sr-only">Skill 실행 로그</caption>
                    <thead>
                      <tr>
                        <th scope="col">실행 시각</th>
                        <th scope="col">호출자</th>
                        <th scope="col">모델</th>
                        <th scope="col">상태</th>
                        <th scope="col">비용</th>
                        <th scope="col">소요</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(runs.data?.runs ?? []).map((entry) => (
                        <tr key={entry.id ?? `${entry.created_at ?? ""}-${entry.actor ?? ""}`}>
                          <td>{formatDateTime(entry.created_at)}</td>
                          <td className="mono">{entry.actor ?? "—"}</td>
                          <td>{entry.model ?? "—"}</td>
                          <td>{entry.status ?? "—"}</td>
                          <td className="cell-number">{formatKRW(entry.cost_krw ?? 0)}</td>
                          <td className="cell-number">{formatDuration(entry.latency_ms ?? 0)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          ) : null}

          {panel === "history" ? (
            <SectionCard title="승격 이력" headingLevel={3}>
              {promotions.isPending ? (
                <p role="status">승격 이력을 불러오는 중입니다.</p>
              ) : promotions.isError ? (
                <InlineNotice
                  tone="danger"
                  title="승격 이력을 불러오지 못했습니다."
                  actions={
                    <Button size="small" onClick={() => void promotions.refetch()}>
                      다시 시도
                    </Button>
                  }
                >
                  {safeAppErrorMessage(promotions.error, "승격 이력을 불러오지 못했습니다.")}
                </InlineNotice>
              ) : (promotions.data?.promotions ?? []).length === 0 ? (
                <EmptyState title="승격 이력이 없습니다." />
              ) : (
                <div className="data-table-scroll" tabIndex={0} aria-label="Skill 승격 이력 표 영역">
                  <table className="data-table">
                    <caption className="sr-only">Skill 승격 이력</caption>
                    <thead>
                      <tr>
                        <th scope="col">시각</th>
                        <th scope="col">전환</th>
                        <th scope="col">버전</th>
                        <th scope="col">담당자</th>
                        <th scope="col">사유</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(promotions.data?.promotions ?? []).map((entry) => (
                        <tr key={entry.id ?? `${entry.created_at ?? ""}-${entry.to_status ?? ""}`}>
                          <td>{formatDateTime(entry.created_at)}</td>
                          <td>
                            {skillStatusLabels[entry.from_status ?? ""] ?? entry.from_status ?? "—"} →{" "}
                            {skillStatusLabels[entry.to_status ?? ""] ?? entry.to_status ?? "—"}
                          </td>
                          <td className="mono">
                            {entry.from_version ?? "—"} → {entry.to_version ?? "—"}
                          </td>
                          <td>{entry.actor ?? "—"}</td>
                          <td className="truncate">{entry.note || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          ) : null}

          {panel === "fitness" ? (
            <SectionCard
              title="모델 적합성 근거"
              headingLevel={3}
              description="높은 위험도 Skill은 통과 근거가 일정 건수 이상이어야 프로덕션으로 승격됩니다."
            >
              {fitness.isPending ? (
                <p role="status">적합성 근거를 불러오는 중입니다.</p>
              ) : fitness.isError ? (
                <InlineNotice
                  tone="danger"
                  title="적합성 근거를 불러오지 못했습니다."
                  actions={
                    <Button size="small" onClick={() => void fitness.refetch()}>
                      다시 시도
                    </Button>
                  }
                >
                  {safeAppErrorMessage(fitness.error, "적합성 근거를 불러오지 못했습니다.")}
                </InlineNotice>
              ) : (
                <>
                  <KeyValueList
                    columns={2}
                    items={[
                      { label: "통과 근거", value: formatNumber(fitness.data?.passing_count ?? 0) },
                      { label: "필요 건수", value: formatNumber(fitness.data?.required ?? 0) },
                    ]}
                  />
                  {(fitness.data?.evidence ?? []).length === 0 ? (
                    <EmptyState
                      title="등록된 근거가 없습니다."
                      description="멀티모델 비교·Golden·테스트케이스 결과를 기존 화면에서 기록하세요."
                    />
                  ) : (
                    <div className="data-table-scroll" tabIndex={0} aria-label="적합성 근거 표 영역">
                      <table className="data-table">
                        <caption className="sr-only">Skill 모델 적합성 근거</caption>
                        <thead>
                          <tr>
                            <th scope="col">종류</th>
                            <th scope="col">참조</th>
                            <th scope="col">통과</th>
                            <th scope="col">점수</th>
                            <th scope="col">기록</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(fitness.data?.evidence ?? []).map((entry) => (
                            <tr key={entry.id ?? `${entry.kind ?? ""}-${entry.created_at ?? ""}`}>
                              <td>{entry.kind ?? "—"}</td>
                              <td className="mono">{entry.ref_id || "—"}</td>
                              <td>
                                <Badge tone={entry.passed ? "success" : "danger"}>
                                  {entry.passed ? "통과" : "실패"}
                                </Badge>
                              </td>
                              <td className="cell-number">{formatNumber(entry.score ?? 0, 2)}</td>
                              <td>
                                {formatDateTime(entry.created_at)} · {entry.created_by ?? ""}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <InlineNotice tone="info" title="근거 기록은 기존 화면에서">
                    적합성 근거 추가(POST /admin/skills/fitness)는 공개 API 계약에 아직 포함되어 있지 않아 이
                    화면에서는 조회만 제공합니다.
                  </InlineNotice>
                </>
              )}
            </SectionCard>
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
