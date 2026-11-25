import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, RotateCcw, Save } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { DLPConfig, DLPIssue, DLPSettings } from "@/shared/api/domains/security-dlp";
import { StickySaveBar } from "@/shared/components/form/StickySaveBar";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";

import { DLPEventsTab } from "./DLPEventsTab";
import { DLPOverviewTab } from "./DLPOverviewTab";
import { DLPPoliciesTab } from "./DLPPoliciesTab";
import { DLPProfilesTab } from "./DLPProfilesTab";
import { DLPTestTab } from "./DLPTestTab";
import {
  changeSummary,
  configFingerprint,
  dlpTabIds,
  dlpTabLabels,
  issueLocation,
  issueTab,
  type DLPTabId,
} from "./dlp-model";
import { dlpKey, isConflict, rejectionIssues, useDLPSettings, useDLPWrites } from "./use-dlp";
import "./dlp.css";

export interface DLPEditorProps {
  settings: DLPSettings;
  draft: DLPConfig;
  onChange: (next: DLPConfig) => void;
  canWrite: boolean;
  writeReason?: string;
  issues: readonly DLPIssue[];
}

export function DLPPage(): React.JSX.Element {
  const settings = useDLPSettings();
  const writes = useDLPWrites();
  const queryClient = useQueryClient();
  const refreshInterval = useRefreshInterval();
  const [tab, setTab] = useTabParam<DLPTabId>(dlpTabIds);
  // The edit starts from one revision of the stored configuration and is saved on
  // top of it; a newer save by someone else is a conflict, never a silent overwrite.
  const [draft, setDraft] = useState<DLPConfig | null>(null);
  const [base, setBase] = useState<{ revision: number; fingerprint: string } | null>(null);
  const [issues, setIssues] = useState<DLPIssue[]>([]);
  const [conflict, setConflict] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);

  const server = settings.data;
  const serverFingerprint = server ? configFingerprint(server.config) : "";
  const dirty = draft !== null && base !== null && configFingerprint(draft) !== base.fingerprint;

  // Adopt a new server copy while rendering (not in an effect, which would paint the
  // stale draft first): always when there is no draft, otherwise only when there is
  // nothing unsaved to lose.
  const serverKey = server ? `${server.revision}:${serverFingerprint}` : "";
  const [adopted, setAdopted] = useState("");
  if (server && (draft === null || (serverKey !== adopted && !dirty))) {
    setAdopted(serverKey);
    setDraft(server.config);
    setBase({ revision: server.revision, fingerprint: serverFingerprint });
  }

  // Leaving the page (or closing the tab) with unsaved changes asks first, through
  // the console's shared unsaved-changes coordinator.
  useDraftGuard({
    dirty,
    keepMounted: true,
    // Tabs and event filters live in the query string; switching them keeps the draft.
    keepsDraftOnSamePage: true,
    externalPending: writes.save.isPending,
    onDiscard: () => {
      if (!server) return;
      setDraft(server.config);
      setBase({ revision: server.revision, fingerprint: serverFingerprint });
      setIssues([]);
    },
  });

  const changes = useMemo(
    () => (server && draft && dirty ? changeSummary(server.config, draft, server.catalog) : []),
    [server, draft, dirty],
  );

  // A profile entry's "시험" sends its example here and opens the test scan.
  const [testSeed, setTestSeed] = useState<{ text: string; id: number } | undefined>(undefined);
  const tryText = (text: string): void => {
    setTestSeed((previous) => ({ text, id: (previous?.id ?? 0) + 1 }));
    setTab("test");
  };

  const issueCounts = useMemo(() => {
    const counts: Partial<Record<DLPTabId, number>> = {};
    for (const issue of issues) {
      const tabId = issueTab(issue);
      counts[tabId] = (counts[tabId] ?? 0) + 1;
    }
    return counts;
  }, [issues]);

  const reload = (): void => {
    setConflict(false);
    setIssues([]);
    setDraft(null);
    setBase(null);
    void queryClient.invalidateQueries({ queryKey: [...dlpKey] });
  };

  const save = (): void => {
    if (!draft || !base) return;
    setIssues([]);
    setConflict(false);
    writes.save.mutate(
      { config: draft, expectedRevision: base.revision, reason: "" },
      {
        onSuccess: (result) => {
          setDraft(result.config);
          setBase({ revision: result.revision, fingerprint: configFingerprint(result.config) });
        },
        onError: (error) => {
          setIssues(rejectionIssues(error) ?? []);
          setConflict(isConflict(error));
        },
      },
    );
  };

  // Ctrl+S (⌘+S) saves while there is something to save.
  const saveShortcut = useRef<() => void>(() => undefined);
  useEffect(() => {
    saveShortcut.current = () => {
      if (dirty && writes.access.allowed && !writes.save.isPending) save();
    };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveShortcut.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const discard = (): void => {
    if (!server) return;
    setDraft(server.config);
    setBase({ revision: server.revision, fingerprint: serverFingerprint });
    setIssues([]);
  };

  const editor: DLPEditorProps | null =
    server && draft
      ? {
          settings: server,
          draft,
          onChange: (next) => setDraft(next),
          canWrite: writes.access.allowed,
          writeReason: writes.access.reason,
          issues,
        }
      : null;

  return (
    <div className="page-stack dlp-page">
      <PageHeader
        title="데이터 유출 방지"
        description="프롬프트와 모델 응답에서 개인정보·금융정보·인증정보를 찾아, 정책에 따라 기록하거나 마스킹하거나 차단합니다. 찾은 값은 어디에도 원문으로 저장하지 않습니다."
        status="preview"
        readOnly={!writes.access.allowed}
        actions={
          <Button onClick={() => void queryClient.invalidateQueries({ queryKey: [...dlpKey] })}>
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      {settings.isError ? (
        <InlineNotice tone="danger" title="DLP 설정을 불러오지 못했습니다.">
          {safeAppErrorMessage(settings.error, "잠시 후 다시 시도하세요.")}
        </InlineNotice>
      ) : null}

      {conflict ? (
        <InlineNotice tone="warning" title="다른 운영자가 먼저 저장했습니다.">
          <p>
            지금 편집 중인 내용은 저장되지 않았습니다. 최신 설정을 불러오면 이 화면의 변경은 사라지니, 필요한
            변경을 기억해 두고 다시 적용하세요.
          </p>
          <Button onClick={reload}>
            <RotateCcw aria-hidden="true" /> 최신 설정 불러오기
          </Button>
        </InlineNotice>
      ) : null}

      {issues.length > 0 && draft ? (
        <InlineNotice tone="danger" title={`설정 오류 ${issues.length}건 — 저장하지 않았습니다.`}>
          <ul className="dlp-issue-list">
            {issues.map((issue) => (
              <li key={`${issue.path}:${issue.message}`}>
                <button type="button" className="dlp-link-button" onClick={() => setTab(issueTab(issue))}>
                  {issueLocation(issue, draft)}
                </button>
                : {issue.message}
              </li>
            ))}
          </ul>
        </InlineNotice>
      ) : null}

      <div className="page-tabs">
        <Tabs
          ariaLabel="데이터 유출 방지 화면 탭"
          items={dlpTabIds.map((id) => ({
            id,
            label: dlpTabLabels[id],
            badge: issueCounts[id] ? <span className="dlp-tab-issues">{issueCounts[id]}</span> : undefined,
          }))}
          onChange={setTab}
          panelIdPrefix="dlp"
          value={tab}
        />
        <TabPanel id={tab} panelIdPrefix="dlp" className="page-stack">
          {!editor ? (
            settings.isPending ? (
              <p className="dlp-muted">불러오는 중…</p>
            ) : null
          ) : (
            <>
              {tab === "overview" ? (
                <DLPOverviewTab {...editor} refreshInterval={refreshInterval} onNavigate={setTab} />
              ) : null}
              {tab === "policies" ? <DLPPoliciesTab {...editor} /> : null}
              {tab === "profiles" ? <DLPProfilesTab {...editor} onTryText={tryText} /> : null}
              {tab === "test" ? (
                <DLPTestTab key={testSeed?.id ?? 0} {...editor} dirty={dirty} seed={testSeed} />
              ) : null}
              {tab === "events" ? (
                <DLPEventsTab
                  settings={editor.settings}
                  draft={editor.draft}
                  refreshInterval={refreshInterval}
                />
              ) : null}
            </>
          )}
        </TabPanel>
      </div>

      {editor && editor.canWrite ? (
        <form
          className="dlp-save-form"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <StickySaveBar label="DLP 설정 저장" dirty={dirty} pending={writes.save.isPending}>
            {changes.length > 0 ? (
              <span className="dlp-change-summary" title={changes.join("\n")}>
                변경 {changes.length}건: {changes.slice(0, 3).join(" · ")}
                {changes.length > 3 ? ` 외 ${changes.length - 3}건` : ""}
              </span>
            ) : null}
            <span className="dlp-muted dlp-revision">
              {base && base.revision > 0 ? `버전 ${base.revision}` : "아직 저장된 적 없음"}
            </span>
            <Button type="button" disabled={!dirty || writes.save.isPending} onClick={discard}>
              <RotateCcw aria-hidden="true" /> 되돌리기
            </Button>
            <Button
              ref={saveRef}
              type="submit"
              variant="primary"
              title="Ctrl+S"
              aria-keyshortcuts="Control+S Meta+S"
              disabled={!dirty || writes.save.isPending}
            >
              <Save aria-hidden="true" /> 저장
            </Button>
          </StickySaveBar>
        </form>
      ) : null}
    </div>
  );
}
