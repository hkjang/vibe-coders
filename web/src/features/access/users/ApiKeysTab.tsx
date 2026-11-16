import { useContext, useRef, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { tokenStore } from "@/shared/auth/token-store";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useFeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { ApiKeyDetailFocusContext } from "./api-key-detail-focus";
import { ApiKeyDetailRoute } from "./ApiKeyDetailRoute";
import { OwnedApiKeysPanel } from "./OwnedApiKeysPanel";

interface ApiKeysTabProps {
  canWrite: boolean;
  isSuperAdmin: boolean;
  writeDeniedReason: string;
}

export function ApiKeysTab(props: ApiKeysTabProps): React.JSX.Element {
  const auth = useAuth();
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const readable =
    ["authenticated", "legacy", "open"].includes(auth.mode) &&
    (auth.mode !== "authenticated" || Boolean(auth.user?.id)) &&
    context?.featureId === "access.users" &&
    context.permitted;
  const owner = JSON.stringify([
    epoch,
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    [...(auth.user?.roles ?? [])].sort(),
    auth.user?.team_id,
    [...(auth.user?.scopes ?? [])].sort(),
    readable,
  ]);
  const readOwner = useFeatureReadOwner("access.users", `api-key-catalog:${owner}`);
  if (readOwner.denied)
    return (
      <InlineNotice tone="warning">
        키 조회 권한이 거부되어 데이터와 작업을 잠갔습니다. 다시 로그인하거나 화면을 다시 열어 권한을
        확인하세요.
      </InlineNotice>
    );
  if (!readable || !readOwner.readable)
    return <InlineNotice tone="warning">현재 계정과 화면에서 API 키를 조회할 수 없습니다.</InlineNotice>;
  return (
    <ApiKeyDetailFocusContext.Provider key={readOwner.id} value={returnFocusRef}>
      <OwnedApiKeysPanel owner={owner} readOwner={readOwner} {...props} />
      <ApiKeyDetailRoute owner={readOwner} />
    </ApiKeyDetailFocusContext.Provider>
  );
}
