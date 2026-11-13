import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import { useRoutingCreateAccess } from "./routing-rule-create-access";

/** Reuse the existing routing ownership, scope and mutation approval guard. */
export function useRoutingOrderAccess(canWrite: boolean) {
  const auth = useAuth();
  const supported =
    typeof auth.backendVersion === "string" && versionAtLeast(auth.backendVersion, "v0.86.91");
  const access = useRoutingCreateAccess(canWrite && supported, "규칙 순서 변경");
  return {
    ...access,
    supported,
    key: `${access.key}:${supported}`,
    reason: supported
      ? access.write.reason
      : "순서 비교와 저장은 백엔드 v0.86.91 이상에서 사용할 수 있습니다.",
  };
}
export type RoutingOrderAccess = ReturnType<typeof useRoutingOrderAccess>;
