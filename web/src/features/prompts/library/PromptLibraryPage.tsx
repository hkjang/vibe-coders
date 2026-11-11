import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";

import { LibraryBoundary } from "./LibraryBoundary";
import { useLibraryOwner } from "./library-context";
import { useLibraryAccess } from "./use-library-mutation";
import { PromptAssetsTab } from "@/features/prompts/library/PromptAssetsTab";
import { PromptDebtTab } from "@/features/prompts/library/PromptDebtTab";
import { PromptSearchTab } from "@/features/prompts/library/PromptSearchTab";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import "@/features/prompts/prompts.css";

const tabIds = ["search", "assets", "debt"] as const;
type TabId = (typeof tabIds)[number];

const tabItems = [
  { id: "search" as const, label: "프롬프트 검색" },
  { id: "assets" as const, label: "자산 관리소" },
  { id: "debt" as const, label: "프롬프트 부채" },
];

export function PromptLibraryPage(): React.JSX.Element {
  return (
    <LibraryBoundary>
      <LibraryContent />
    </LibraryBoundary>
  );
}

function LibraryContent(): React.JSX.Element {
  const owner = useLibraryOwner();
  const access = useLibraryAccess();
  const queryClient = useQueryClient();
  const [tab, setTab] = useTabParam<TabId>(tabIds);
  const canWrite = access.allowed;

  return (
    <div className="page-stack">
      <PageHeader
        title="프롬프트 라이브러리"
        status="preview"
        description="프롬프트 검색과 지문, 재사용 자산, 프롬프트 부채를 한곳에서 관리합니다."
        legacyHref="/admin#/prompts"
        actions={
          <Button
            variant="primary"
            onClick={() =>
              void queryClient.invalidateQueries({
                predicate: (query) =>
                  query.queryKey.at(-2) === owner.marker && query.queryKey.at(-1) === owner.id,
              })
            }
          >
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      {!canWrite ? (
        <InlineNotice tone="info" title="읽기 전용으로 열려 있습니다.">
          {access.reason} 초안은 유지되며 조회는 그대로 사용할 수 있습니다.
        </InlineNotice>
      ) : null}

      <Tabs
        ariaLabel="프롬프트 라이브러리 화면"
        items={tabItems}
        value={tab}
        onChange={setTab}
        panelIdPrefix="prompts-library"
      />

      {tab === "search" ? (
        <TabPanel id="search" panelIdPrefix="prompts-library">
          <PromptSearchTab canWrite={canWrite} />
        </TabPanel>
      ) : null}
      {tab === "assets" ? (
        <TabPanel id="assets" panelIdPrefix="prompts-library">
          <PromptAssetsTab canWrite={canWrite} />
        </TabPanel>
      ) : null}
      {tab === "debt" ? (
        <TabPanel id="debt" panelIdPrefix="prompts-library">
          <PromptDebtTab />
        </TabPanel>
      ) : null}
    </div>
  );
}
