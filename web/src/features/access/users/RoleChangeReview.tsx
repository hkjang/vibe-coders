import { roleChanges, type RoleDraft } from "./role-changes";

export function RoleChangeReview({ baseline, draft }: { baseline?: RoleDraft; draft: RoleDraft }) {
  const { changes, added, removed } = roleChanges(baseline, draft);
  return (
    <section aria-label="역할 변경 전후 비교" className="access-stack access-role-change-review">
      <h3>저장할 변경 내용</h3>
      <p>
        권한 추가 {added.length}개 · 제거 {removed.length}개
      </p>
      {changes.length ? (
        <div
          className="data-table-scroll"
          role="region"
          tabIndex={0}
          aria-label="역할 변경 비교 표, 가로 스크롤 가능"
        >
          <table className="data-table">
            <caption className="sr-only">편집 시작 시점과 저장할 역할 변경 비교</caption>
            <thead>
              <tr>
                <th scope="col">항목</th>
                <th scope="col">변경 전</th>
                <th scope="col">변경 후</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((change) => (
                <tr key={change.id}>
                  <th scope="row">{change.label}</th>
                  <td>{change.before}</td>
                  <td>{change.after}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>{baseline ? "변경된 항목이 없습니다." : "역할 이름과 권한을 입력하면 변경 내용을 표시합니다."}</p>
      )}
      <p>
        편집을 시작한 값과 현재 입력을 비교합니다. 권한 변경은 이 역할을 사용하는 계정과 키의 접근에 영향을 줄
        수 있습니다. 실제 영향 대상과 적용 시점은 이 표에서 확인하지 않습니다. 저장 직전 서버 값을 다시
        확인하지만 다른 관리자의 동시 변경을 잠그지는 않습니다.
      </p>
    </section>
  );
}
