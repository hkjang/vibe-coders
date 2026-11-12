import { useEffect, useRef, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useLocation } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import {
  sanitizeAppRouteSearch,
  locationStateWithSensitiveRejections,
} from "@/shared/security/app-route-query";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { TabPanel, Tabs, type TabItem } from "@/shared/components/ui/Tabs";
import type { AccessTab } from "./users-page-tabs";
import "@/features/access/access.css";

const tabs: ReadonlyArray<TabItem<AccessTab>> = [
  { id: "users", label: "사용자" },
  { id: "teams", label: "팀" },
  { id: "keys", label: "API 키" },
  { id: "ips", label: "IP" },
  { id: "quotas", label: "할당량·예산" },
  { id: "roles", label: "역할" },
];

// A tab navigation may mount a separately loaded route. Restore its keyboard
// focus after that route commits; direct/deep-link entry does not steal focus.
export function UsersPageShell({
  tab,
  canWrite,
  children,
}: {
  tab: AccessTab;
  canWrite: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { credentialPrefixes } = useAuth();
  const location = useLocation();
  const queryClient = useQueryClient();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if ((location.state as { accessTabFocus?: boolean } | null)?.accessTabFocus) {
      root.current?.querySelector<HTMLButtonElement>(`[data-tab-id="${tab}"]`)?.focus();
    }
  }, [tab, location.key, location.state]);
  const changeTab = (next: AccessTab) => {
    const params = new URLSearchParams(location.search);
    if (next === "users") params.delete("tab");
    else params.set("tab", next);
    const pathname = next === "ips" ? "/access/users/ips" : "/access/users";
    const safe = sanitizeAppRouteSearch(pathname, params.toString(), credentialPrefixes);
    void navigate(
      { pathname, search: safe.search },
      {
        replace: true,
        state: locationStateWithSensitiveRejections({ accessTabFocus: true }, safe.sensitiveKeys),
      },
    );
  };
  return (
    <div className="page-stack" ref={root}>
      <PageHeader
        title="사용자와 팀"
        description="로그인 계정, 팀, API 키, IP 사용량, 할당량·예산과 역할을 한 곳에서 관리합니다."
        readOnly={!canWrite}
        legacyHref="/admin#/users"
        actions={
          <Button
            variant="primary"
            onClick={() => void queryClient.invalidateQueries({ queryKey: ["access"] })}
          >
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />
      <Tabs ariaLabel="접근 관리 영역" items={tabs} value={tab} onChange={changeTab} panelIdPrefix="access" />
      <TabPanel key={tab} id={tab} panelIdPrefix="access">
        {children}
      </TabPanel>
    </div>
  );
}
