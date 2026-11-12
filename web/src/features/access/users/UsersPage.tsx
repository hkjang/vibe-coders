import { Navigate, useLocation } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { ApiKeysTab } from "./ApiKeysTab";
import { QuotasTab } from "./QuotasTab";
import { RolesTab } from "./RolesTab";
import { TeamsTab } from "./TeamsTab";
import { UsersTab } from "./UsersTab";
import { UsersPageShell } from "./UsersPageShell";
import { accessTabIds, type AccessTab } from "./users-page-tabs";
import { useTabParam } from "@/shared/hooks/use-tab-param";

export function UsersPage(): React.JSX.Element {
  const auth = useAuth();
  const location = useLocation();
  const [tab] = useTabParam<AccessTab>(accessTabIds);
  const scopes = auth.user?.scopes ?? [];
  const role = auth.user?.role ?? "";
  // The existing server verifies team-admin writes against the target team.
  const canWrite = scopes.includes("admin:write") || role === "team_admin";
  const isSuperAdmin = role === "super_admin";
  const writeDeniedReason =
    "변경 권한(admin:write)이 없어 읽기만 할 수 있습니다. 관리자에게 권한을 요청하세요.";
  // Preserve old bookmarks and all validated table/detail parameters.
  if (tab === "ips")
    return <Navigate replace to={{ pathname: "/access/users/ips", search: location.search }} />;
  return (
    <UsersPageShell tab={tab} canWrite={canWrite}>
      {tab === "users" ? <UsersTab canWrite={canWrite} writeDeniedReason={writeDeniedReason} /> : null}
      {tab === "teams" ? <TeamsTab canWrite={canWrite} writeDeniedReason={writeDeniedReason} /> : null}
      {tab === "keys" ? (
        <ApiKeysTab canWrite={canWrite} isSuperAdmin={isSuperAdmin} writeDeniedReason={writeDeniedReason} />
      ) : null}
      {tab === "quotas" ? <QuotasTab canWrite={canWrite} writeDeniedReason={writeDeniedReason} /> : null}
      {tab === "roles" ? <RolesTab canWrite={canWrite} writeDeniedReason={writeDeniedReason} /> : null}
    </UsersPageShell>
  );
}
