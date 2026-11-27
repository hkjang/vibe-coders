import { Plus, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import type { WorkBaseline } from "@/shared/api/domains/insights-classification";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatKRW, formatNumber } from "@/shared/utils/format";

import type { PolicyEditorProps } from "./ClassificationPage";
import { baselineProblems, baselineSaving, categoryPath, issueAt } from "./classification-model";
import { CategorySelect, NumberField } from "./fields";

export function BaselinesTab({
  draft,
  onChange,
  canWrite,
  writeReason,
  issues,
}: PolicyEditorProps): React.JSX.Element {
  const [adding, setAdding] = useState("");
  const used = useMemo(
    () => new Set(draft.baselines.map((baseline) => baseline.category_id)),
    [draft.baselines],
  );
  const lockTitle = canWrite ? undefined : writeReason;
  const patch = (index: number, next: Partial<WorkBaseline>): void =>
    onChange({
      ...draft,
      baselines: draft.baselines.map((baseline, at) => (at === index ? { ...baseline, ...next } : baseline)),
    });
  const add = (): void => {
    if (!adding || used.has(adding)) return;
    onChange({
      ...draft,
      baselines: [
        ...draft.baselines,
        { category_id: adding, manual_minutes: 60, ai_minutes: 15, hourly_cost_krw: 50000, note: "" },
      ],
    });
    setAdding("");
  };

  return (
    <>
      <InlineNotice tone="info" title="절감 효과는 추정치입니다.">
        기준값은 「이 업무를 사람이 직접 하면 몇 분, AI를 쓰면 몇 분, 그 시간의 비용은 얼마」라는 가정입니다.
        업무 활용 분석의 생산성 탭은 이 가정으로 절감 시간과 비용을 추정하며, 완료가 확인된 세션(사용자가 긍정
        피드백을 남긴 세션)에 대해서만 계산합니다. API 호출이 성공했다는 것만으로는 완료로 보지 않으므로 실제
        효과보다 작게 나올 수 있습니다. 기준값이 없는 카테고리는 추정하지 않습니다.
      </InlineNotice>

      <SectionCard
        headingLevel={3}
        title={`카테고리별 기준값 (${draft.baselines.length})`}
        description="기준값도 정책 초안의 일부라, 저장하고 배포해야 분석에 쓰입니다."
      >
        <div className="wc-baseline-add">
          <FormField label="기준값을 추가할 카테고리">
            {(control) => (
              <CategorySelect
                {...control}
                categories={draft.categories}
                value={adding}
                emptyLabel="카테고리 선택"
                exclude={used}
                disabled={!canWrite}
                onChange={setAdding}
              />
            )}
          </FormField>
          <Button disabled={!canWrite || adding === ""} title={lockTitle} onClick={add}>
            <Plus aria-hidden="true" /> 기준값 추가
          </Button>
        </div>

        {draft.baselines.length === 0 ? (
          <EmptyState
            title="아직 기준값이 없습니다."
            description="기준값을 넣은 카테고리만 절감 시간과 비용을 추정합니다. 자주 쓰는 업무부터 추가해 보세요."
          />
        ) : (
          <fieldset className="wc-fieldset" disabled={!canWrite}>
            <legend className="sr-only">카테고리별 기준값</legend>
            <ul className="wc-card-list" aria-label="기준값 목록">
              {draft.baselines.map((baseline, index) => {
                const path = `baselines[${index}]`;
                const local = baselineProblems(baseline);
                const saving = baselineSaving(baseline);
                const name =
                  categoryPath(draft.categories, baseline.category_id).join(" › ") || baseline.category_id;
                const valid = Object.keys(local).length === 0;
                return (
                  <li key={baseline.category_id} className="wc-card">
                    <div className="wc-version-head">
                      <strong>{name}</strong>
                      <code className="wc-muted">{baseline.category_id}</code>
                    </div>
                    {issueAt(issues, `${path}.category_id`) ? (
                      <p className="field-error" role="alert">
                        {issueAt(issues, `${path}.category_id`)}
                      </p>
                    ) : null}
                    <div className="wc-form-grid">
                      <NumberField
                        label="수동 처리 시간(분)"
                        description="AI 없이 사람이 한 건을 처리하는 데 걸리는 시간"
                        min={0}
                        step={1}
                        value={baseline.manual_minutes}
                        error={issueAt(issues, `${path}.manual_minutes`) ?? local.manual_minutes}
                        onChange={(manual_minutes) => patch(index, { manual_minutes })}
                      />
                      <NumberField
                        label="AI 활용 처리 시간(분)"
                        description="AI를 써서 한 건을 처리하는 데 걸리는 시간"
                        min={0}
                        step={1}
                        value={baseline.ai_minutes}
                        error={issueAt(issues, `${path}.ai_minutes`) ?? local.ai_minutes}
                        onChange={(ai_minutes) => patch(index, { ai_minutes })}
                      />
                      <NumberField
                        label="시간당 비용(원)"
                        description="이 업무를 하는 사람의 시간당 인건비"
                        min={0}
                        step={1000}
                        value={baseline.hourly_cost_krw}
                        error={issueAt(issues, `${path}.hourly_cost_krw`) ?? local.hourly_cost_krw}
                        onChange={(hourly_cost_krw) => patch(index, { hourly_cost_krw })}
                      />
                    </div>
                    <FormField label="메모" description="이 가정의 근거(측정 방법, 출처)를 적어 두세요.">
                      {(control) => (
                        <Input
                          {...control}
                          value={baseline.note}
                          maxLength={200}
                          onChange={(event) => patch(index, { note: event.target.value })}
                        />
                      )}
                    </FormField>
                    <div className="wc-card-actions">
                      <span className="wc-muted" role="status">
                        {!valid
                          ? "값을 고치면 추정 절감을 보여 줍니다."
                          : saving.minutes > 0
                            ? `완료 확인된 세션 1건당 추정 절감: ${formatNumber(saving.minutes, 1)}분 · ${formatKRW(Math.round(saving.costKrw))}`
                            : "AI 활용 시간이 수동 처리 시간보다 길거나 같아 절감이 0 이하로 계산됩니다."}
                      </span>
                      <Button
                        size="small"
                        variant="ghost"
                        aria-label={`${name} 기준값 삭제`}
                        onClick={() =>
                          onChange({ ...draft, baselines: draft.baselines.filter((_, at) => at !== index) })
                        }
                      >
                        <Trash2 aria-hidden="true" /> 삭제
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
      </SectionCard>
    </>
  );
}
