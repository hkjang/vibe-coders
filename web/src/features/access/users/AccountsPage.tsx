import { Navigate, useLocation } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { UsersTab } from "./UsersTab";
import { UsersPageShell } from "./UsersPageShell";
import { accessTabIds, type AccessTab } from "./users-page-tabs";

/** Independent account route keeps unrelated management editors out of its bundle. */
export function AccountsPage() {
  const auth = useAuth();
  const location = useLocation();
  const [tab] = useTabParam<AccessTab>(accessTabIds);
  const canWrite = (auth.user?.scopes ?? []).includes("admin:write") || auth.user?.role === "team_admin";
  if (tab !== "users")
    return <Navigate replace to={{ pathname: "/access/users", search: location.search }} />;
  return (
    <UsersPageShell tab="users" canWrite={canWrite}>
      <UsersTab
        canWrite={canWrite}
        writeDeniedReason="변경 권한(admin:write)이 없어 읽기만 할 수 있습니다. 관리자에게 권한을 요청하세요."
      />
    </UsersPageShell>
  );
}
