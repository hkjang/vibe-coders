import type { SavedRequestCriteria } from "./request-saved-filter";

export function RequestCriteriaReview({ criteria }: { criteria: SavedRequestCriteria }): React.JSX.Element {
  return (
    <div className="saved-request-review">
      <dl aria-label="저장 조건 미리보기">
        {criteria.entries.map(({ label, value }) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p>
        저장된 시각을 그대로 사용하며 첫 페이지부터 조회합니다. 시작·종료 시각이 없으면 전체 기간을
        조회합니다.
      </p>
    </div>
  );
}
