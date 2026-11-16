import type { RefObject } from "react";
import type { ProfileReviewInput, ReviewedProfile } from "@/shared/api/domains/text2sql-profile-review";
import type { Text2SQLConnectionRow } from "@/shared/api/domains/text2sql";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Text2SqlProfileConnection } from "../overview/Text2SqlProfileConnection";
import { profileFields, profileValueLabel } from "./profile-form";

export function ProfileChangeReview({
  before,
  after,
  heading,
  connections,
  connectionsLoading,
  connectionsError,
}: {
  before: ReviewedProfile | null;
  after: ProfileReviewInput;
  heading: RefObject<HTMLHeadingElement | null>;
  connections: readonly Text2SQLConnectionRow[];
  connectionsLoading: boolean;
  connectionsError: unknown;
}): React.JSX.Element {
  return (
    <div className="page-stack">
      <h3 ref={heading} tabIndex={-1}>
        프로필 변경 검토
      </h3>
      <p>
        <code>{after.virtual_model}</code>로 들어오는 이후 요청에 적용됩니다. 진행 중인 요청에는 소급 적용되지
        않습니다.
      </p>
      <div className="t2s-profile-diff" role="region" aria-label="프로필 변경 비교" tabIndex={0}>
        <table>
          <caption>변경 전후 설정</caption>
          <thead>
            <tr>
              <th scope="col">항목</th>
              <th scope="col">변경 전</th>
              <th scope="col">변경 후</th>
            </tr>
          </thead>
          <tbody>
            {profileFields
              .filter(([key]) => !before || before[key] !== after[key])
              .map(([key, label]) => (
                <tr key={key}>
                  <th scope="row">{label}</th>
                  <td>{before ? profileValueLabel(key, before[key]) : "신규 프로필"}</td>
                  <td>{profileValueLabel(key, after[key])}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
      <InlineNotice
        tone="warning"
        title={after.enabled ? "이후 요청의 적용 범위" : "프로필 미적용 시 서버 기본 설정 사용"}
      >
        {after.enabled
          ? after.mode === "execute"
            ? "실행 모드는 SQL 생성 후 선택한 DB에서 조회를 시도합니다. 기존 실행 권한과 중지 설정은 계속 적용됩니다."
            : "미리보기 모드는 SQL을 생성하며 실행 DB에서 조회하지 않습니다."
          : "이 프로필을 끄면 서버 기본 설정을 사용합니다. SQL 실행을 중지하려면 별도의 긴급 중지 기능을 사용하세요."}
      </InlineNotice>
      <div>
        설정된 실행 DB:{" "}
        <Text2SqlProfileConnection
          id={after.exec_connection_id}
          connections={connections}
          loading={connectionsLoading}
          error={connectionsError}
        />
      </div>
      <p>
        프로필 저장은 DB 연결 점검이나 SQL 실행을 수행하지 않습니다. 연결·스키마 설정은 별도로 바뀔 수
        있습니다.
      </p>
      <p>
        <strong>변경 사유</strong>
        <br />
        {after.reason}
      </p>
    </div>
  );
}
