import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import "./policies.css";
import type { PolicyTab } from "./policy-navigation";
const tabItems = [
  { id: "safety" as const, label: "안전 정책" },
  { id: "sunset" as const, label: "모델 일몰" },
  { id: "advisor" as const, label: "정책 추천" },
];

/** Shared navigation without importing either independent policy screen. */
export function PoliciesLayout({
  tab,
  canWrite,
  children,
}: {
  tab: PolicyTab;
  canWrite: boolean;
  children: ReactNode;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const panel = useRef<HTMLDivElement | null>(null);
  const focusTab = (location.state as { policyTabFocus?: boolean } | null)?.policyTabFocus === true;
  useLayoutEffect(() => {
    if (focusTab) panel.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [location.key, focusTab]);
  const [params] = useSearchParams();
  const changeTab = (next: PolicyTab) => {
    const search = new URLSearchParams(params);
    search.set("tab", next);
    navigate(
      {
        pathname: next === "advisor" ? "/governance/policies/advisor" : "/governance/policies",
        search: search.toString(),
      },
      { replace: true, state: { policyTabFocus: true } },
    );
  };
  return (
    <div className="page-stack" ref={panel}>
      <PageHeader
        title="정책 및 거버넌스"
        readOnly={!canWrite}
        description="긴급 정지·정책·승인·알림·모델 일몰·정책 추천을 관리합니다."
        legacyHref="/admin#/safety"
        actions={
          <Button
            variant="primary"
            onClick={() => void client.invalidateQueries({ queryKey: ["governance"] })}
          >
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />
      {!canWrite ? (
        <InlineNotice tone="info" title="읽기 전용으로 열려 있습니다.">
          긴급 정지·정책 저장·승인은 admin:write 권한이 필요합니다. 조회는 가능합니다.
        </InlineNotice>
      ) : null}
      <Tabs
        ariaLabel="정책 및 거버넌스 화면"
        items={tabItems}
        value={tab}
        onChange={changeTab}
        panelIdPrefix="governance-policies"
      />
      <TabPanel key={tab} id={tab} panelIdPrefix="governance-policies">
        {children}
      </TabPanel>
    </div>
  );
}
