import type { ReviewedProfile } from "@/shared/api/domains/text2sql-profile-review";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { profileFields, profileValueLabel } from "./profile-form";

export function ProfileDeleteImpact({
  current,
  previous,
}: {
  current: ReviewedProfile;
  previous?: ReviewedProfile;
}): React.JSX.Element {
  return (
    <>
      <InlineNotice tone="warning" title="프로필 삭제는 SQL 실행 중지가 아닙니다">
        이 가상 모델의 저장된 설정만 삭제합니다. 이후 요청은 서버 기본 설정과 기본 모델 규칙을 사용합니다.
        등록되지 않은 이름은 기본 미리보기 규칙을 따릅니다. 실행 DB의 테이블·데이터는 삭제하지 않습니다.
      </InlineNotice>
      <div className="t2s-profile-diff" role="region" aria-label="삭제 대상 설정" tabIndex={0}>
        <table>
          <caption>삭제할 프로필의 검토 기준</caption>
          <thead>
            <tr>
              <th scope="col">항목</th>
              {previous ? <th scope="col">이전 검토</th> : null}
              <th scope="col">삭제 대상</th>
            </tr>
          </thead>
          <tbody>
            {profileFields.map(([key, label]) => (
              <tr key={key}>
                <th scope="row">{label}</th>
                {previous ? <td>{profileValueLabel(key, previous[key])}</td> : null}
                <td>
                  {profileValueLabel(key, current[key])}
                  {previous && previous[key] !== current[key] ? <strong> · 변경됨</strong> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        삭제 검토는 위 프로필 설정에만 적용됩니다. 연결·스키마·서버 기본 설정은 별도로 변경될 수 있으며, 이
        작업은 DB 접속이나 SQL 실행을 하지 않습니다.
      </p>
    </>
  );
}
