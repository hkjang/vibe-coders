import { Link } from "react-router";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { PolicySearchDetail } from "./PolicySearchDetail";
import "./policy-search.css";

/** The deep-link loads without downloading the policy editors and simulations. */
export function PolicySearchPage(): React.JSX.Element {
  return (
    <div className="page-stack">
      <PageHeader
        title="정책 및 거버넌스"
        description="자원 검색에서 선택한 정책의 현재 상태를 읽기 전용으로 확인합니다."
        readOnly
        legacyHref="/admin#/safety"
      />
      <p>
        다른 정책을 확인하려면 명령 팔레트의 자원 검색을 이용하세요. 편집과 시뮬레이션은 정책 목록에서
        시작합니다.
      </p>
      <Link className="button button-secondary button-default" to="/governance/policies?tab=safety">
        정책 목록 열기
      </Link>
      <PolicySearchDetail />
    </div>
  );
}
