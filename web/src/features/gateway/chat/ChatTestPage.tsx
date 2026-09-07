import { useAuth } from "@/app/auth/AuthProvider";
import { ChatComparePanel } from "@/features/gateway/chat/ChatComparePanel";
import { ChatInsightsPanel } from "@/features/gateway/chat/ChatInsightsPanel";
import { ChatRunPanel } from "@/features/gateway/chat/ChatRunPanel";
import { ModelTagPanel } from "@/features/gateway/chat/ModelTagPanel";
import "@/features/gateway/gateway.css";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { TabPanel, Tabs, type TabItem } from "@/shared/components/ui/Tabs";
import { useTabParam } from "@/shared/hooks/use-tab-param";

const tabIds = ["run", "compare", "insights", "tags"] as const;
type ChatTabId = (typeof tabIds)[number];

const tabs: ReadonlyArray<TabItem<ChatTabId>> = [
  { id: "run", label: "단일 호출" },
  { id: "compare", label: "멀티 모델 비교" },
  { id: "insights", label: "리더보드" },
  { id: "tags", label: "모델 용도 태그" },
];

export function ChatTestPage(): React.JSX.Element {
  const auth = useAuth();
  const [tab, setTab] = useTabParam<ChatTabId>(tabIds);
  const scopes = auth.user?.scopes ?? [];
  const canWrite = scopes.includes("admin:write");
  const canPreviewRouting = scopes.includes("routing:read");
  const writeDeniedReason = "이 작업은 admin:write 권한이 필요합니다. 관리자에게 권한을 요청하세요.";

  return (
    <div className="page-stack">
      <PageHeader
        title="Chat 테스트"
        status="preview"
        description="게이트웨이를 통해 모델을 직접 호출하고, 여러 모델의 응답을 비교합니다."
        legacyHref="/admin#/chat-test"
      />

      <InlineNotice tone="info" title="실제 호출입니다.">
        여기서 보내는 요청은 실제 공급자로 나가며 비용이 발생합니다. 프롬프트와 응답은 이 화면에만 남고 주소나
        브라우저 저장소에 저장되지 않습니다.
      </InlineNotice>

      <Tabs
        ariaLabel="Chat 테스트 화면"
        items={tabs}
        onChange={setTab}
        panelIdPrefix="gateway-chat"
        value={tab}
      />

      <TabPanel id={tab} panelIdPrefix="gateway-chat">
        {tab === "run" ? (
          <ChatRunPanel
            canPreviewRouting={canPreviewRouting}
            canWrite={canWrite}
            writeDeniedReason={writeDeniedReason}
          />
        ) : null}
        {tab === "compare" ? (
          <ChatComparePanel canWrite={canWrite} writeDeniedReason={writeDeniedReason} />
        ) : null}
        {tab === "insights" ? <ChatInsightsPanel /> : null}
        {tab === "tags" ? <ModelTagPanel canWrite={canWrite} writeDeniedReason={writeDeniedReason} /> : null}
      </TabPanel>
    </div>
  );
}
