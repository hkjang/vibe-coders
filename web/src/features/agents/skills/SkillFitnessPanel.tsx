import { useSkillFitnessContext } from "./skill-fitness-context";
import { fitnessKindLabel } from "./skill-fitness-state";
import { SkillFitnessDialog } from "./SkillFitnessDialog";
import { SkillFitnessNotice } from "./SkillFitnessNotice";
import { useSkillFitnessQuery } from "./use-skill-fitness-editor";
import type { Skill } from "@/shared/api/domains/agents.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import "./skill-fitness.css";

export function SkillFitnessPanel({
  skill: selectedSkill,
  canWrite,
}: {
  skill: Skill;
  canWrite: boolean;
}): React.JSX.Element {
  const editor = useSkillFitnessContext();
  const skill = editor.target?.skill ?? selectedSkill;
  const current = useSkillFitnessQuery(skill.name, editor.epoch);
  const confirmed = current.confirmed;
  const allowed = canWrite && editor.writable;
  return (
    <SectionCard
      title="모델 적합성 근거"
      headingLevel={3}
      description="높은 위험도 또는 적합성 검증을 요구한 스킬의 프로덕션 승격에 통과한 기록 건수가 사용됩니다."
    >
      <SkillFitnessNotice name={skill.name} current={current} />
      {!allowed ? (
        <InlineNotice tone="warning" title="쓰기 권한이 없습니다.">
          {editor.writeDisabledReason ?? "스킬 근거 기록에는 admin:write 권한이 필요합니다."}
        </InlineNotice>
      ) : null}
      {confirmed ? (
        <>
          <KeyValueList
            columns={2}
            items={[
              { label: "통과 근거", value: formatNumber(confirmed.passing_count) },
              { label: "승격 기준 건수", value: formatNumber(confirmed.required) },
            ]}
          />
          {confirmed.evidence.length === 0 ? (
            <EmptyState
              title="등록된 근거가 없습니다."
              description="‘근거 기록’에서 평가 결과를 새 근거로 남길 수 있습니다."
            />
          ) : (
            <div className="data-table-scroll" tabIndex={0} aria-label="적합성 근거 표 영역">
              <table className="data-table">
                <caption className="sr-only">스킬 모델 적합성 근거</caption>
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
                  {confirmed.evidence.map((entry) => (
                    <tr key={entry.id}>
                      <td title={entry.kind}>{fitnessKindLabel(entry.kind)}</td>
                      <td className="skill-fitness-value mono">{entry.ref_id || "미지정"}</td>
                      <td>
                        <Badge tone={entry.passed ? "success" : "danger"}>
                          {entry.passed ? "통과" : "실패"}
                        </Badge>
                      </td>
                      <td className="cell-number">{String(entry.score)}</td>
                      <td className="skill-fitness-value">
                        {formatDateTime(entry.created_at)} · {entry.created_by || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
      {editor.committed?.name === skill.name && !confirmed ? (
        <InlineNotice tone="warning" title="적합성 근거 기록은 완료됐습니다.">
          후속 조회가 완료되지 않았습니다. 같은 근거를 다시 기록하지 말고 목록을 다시 조회하세요.
        </InlineNotice>
      ) : null}
      <div className="agents-inline-actions">
        <Button
          disabled={current.query.isFetching || editor.pending}
          onClick={() => void current.query.refetch()}
        >
          적합성 근거 새로고침
        </Button>
        <Button
          variant="primary"
          disabled={!allowed || !confirmed || Boolean(editor.target)}
          onClick={(event) => {
            if (allowed) editor.open(skill, event.currentTarget);
          }}
        >
          근거 기록
        </Button>
      </div>
      {editor.target ? (
        <SkillFitnessDialog
          key={`${editor.target.epoch}:${editor.target.instance}`}
          target={editor.target}
          editor={editor}
          current={current}
          canWrite={allowed}
        />
      ) : null}
    </SectionCard>
  );
}
