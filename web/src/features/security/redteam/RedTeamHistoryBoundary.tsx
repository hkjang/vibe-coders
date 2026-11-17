import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import { useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { rejectedSensitiveQuery } from "@/shared/security/app-route-query";
import { readRunQuery, runQueryKeys } from "@/shared/utils/redteam-run-query";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Button } from "@/shared/components/ui/Button";
import { RunHistoryContext } from "./run-history-context";

export function RedTeamHistoryBoundary({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const location = useLocation();
  const [params, update] = useSearchState();
  const search = readRunQuery(params, auth.credentialPrefixes);
  const supported = versionAtLeast(auth.backendVersion, "v0.86.145");
  const owner = useFeatureReadOwner("security.redteam", "redteam-run-history");
  if (!owner.readable || owner.denied)
    return (
      <InlineNotice tone="warning" title="실행 이력 조회 권한을 확인하세요.">
        <p>인증 또는 조회 권한이 바뀌어 기존 이력과 상세를 닫았습니다.</p>
        {owner.readable ? <Button onClick={owner.restart}>권한 다시 확인</Button> : null}
      </InlineNotice>
    );
  const rejected = runQueryKeys.some((key) => rejectedSensitiveQuery(location.state, key));
  if (rejected || !search.valid || (!supported && runQueryKeys.some((key) => params.has(key))))
    return (
      <InlineNotice tone="warning" title="실행 이력 조건을 확인하세요.">
        <p>
          {!supported
            ? "이 주소의 실행 이력 조건은 서버 v0.86.145 이상에서 사용할 수 있습니다."
            : "주소에 잘못된 조건 또는 민감한 정보가 포함되어 조회를 중단했습니다."}
        </p>
        <Button onClick={() => update(Object.fromEntries(runQueryKeys.map((key) => [key, null])))}>
          실행 이력 조건 초기화
        </Button>
      </InlineNotice>
    );
  return (
    <RunHistoryContext.Provider key={owner.id} value={owner}>
      {children}
    </RunHistoryContext.Provider>
  );
}
