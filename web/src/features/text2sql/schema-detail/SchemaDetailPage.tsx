import { legacyRoutes } from "@/config/legacy-route-map";
import { Link, useSearchParams } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Button } from "@/shared/components/ui/Button";
import { useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { validSchemaDetailName } from "./schema-detail-model";
import { SchemaDetailData } from "./SchemaDetailData";
import "./schema-detail.css";

export function SchemaDetailPage() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const names = params.getAll("schema_name");
  const name = names[0] ?? "";
  const valid = names.length === 1 && validSchemaDetailName(name, auth.credentialPrefixes);
  const supported = versionAtLeast(auth.backendVersion, "v0.86.107");
  const owner = useFeatureReadOwner("text2sql.overview", "text2sql-schema-detail");
  return (
    <div className="page-stack schema-detail-page">
      <PageHeader
        title="Text2SQL 스키마 상세"
        description="선택한 스키마의 등록 상태와 현재 허용된 설명을 읽기 전용으로 확인합니다."
        readOnly
        legacyHref={owner.readable ? legacyRoutes.text2sql : undefined}
        actions={
          owner.readable ? (
            <Link className="button button-secondary button-default" to="/text2sql?tab=schemas">
              스키마 목록 열기
            </Link>
          ) : undefined
        }
      />
      {!valid ? (
        <InlineNotice tone="danger" title="스키마 상세 주소를 확인하세요.">
          안전한 스키마 이름 하나를 지정하세요. 목록이나 자원 검색에서 다시 선택할 수 있습니다.
        </InlineNotice>
      ) : null}
      {valid && !supported ? (
        <InlineNotice tone="info" title="서버 업데이트가 필요합니다.">
          이 상세 조회는 v0.86.107 이상에서 지원합니다.
        </InlineNotice>
      ) : null}
      {valid && supported && (!owner.readable || owner.denied) ? (
        <InlineNotice
          tone="warning"
          title="스키마 조회 권한을 확인하세요."
          actions={
            owner.readable && owner.denied ? (
              <Button onClick={owner.restart}>권한 다시 확인</Button>
            ) : undefined
          }
        >
          이전 스키마 정보는 표시하지 않습니다. 현재 계정의 조회 권한을 확인하세요.
        </InlineNotice>
      ) : null}
      {valid && supported && owner.readable && !owner.denied ? (
        <SchemaDetailData key={JSON.stringify([owner.id, name])} name={name} owner={owner} />
      ) : null}
    </div>
  );
}
