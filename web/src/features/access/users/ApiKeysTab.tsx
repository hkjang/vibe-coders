import { useContext, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { tokenStore } from "@/shared/auth/token-store";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { OwnedApiKeysPanel } from "./OwnedApiKeysPanel";

interface ApiKeysTabProps {
  canWrite: boolean;
  isSuperAdmin: boolean;
  writeDeniedReason: string;
}

export function ApiKeysTab(props: ApiKeysTabProps): React.JSX.Element {
  const auth = useAuth();
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
  if (!readable)
    return <InlineNotice tone="warning">현재 계정과 화면에서 API 키를 조회할 수 없습니다.</InlineNotice>;
  return <OwnedApiKeysPanel key={owner} owner={owner} {...props} />;
}
