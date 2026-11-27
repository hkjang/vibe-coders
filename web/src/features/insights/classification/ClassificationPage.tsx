import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, RotateCcw, Save, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import type {
  WorkPolicy,
  WorkPolicyConfig,
  WorkPolicyIssue,
} from "@/shared/api/domains/insights-classification";
import { StickySaveBar } from "@/shared/components/form/StickySaveBar";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";
import { useSearchState, type SearchUpdates } from "@/shared/hooks/use-search-state";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";

import { BaselinesTab } from "./BaselinesTab";
import { CategoriesTab } from "./CategoriesTab";
import { PolicyTab } from "./PolicyTab";
import { ReclassifyTab } from "./ReclassifyTab";
import { ReviewTab } from "./ReviewTab";
import { StatusTab } from "./StatusTab";
import { TestTab } from "./TestTab";
import {
  changeSummary,
  classificationTabIds,
  classificationTabLabels,
  configFingerprint,
  issueCategoryId,
  issueLocation,
  issueTab,
  localIssues,
  tabScopedQueryKeys,
  workIntelSettingsLink,
  type ClassificationTabId,
} from "./classification-model";
import {
  classificationErrorMessage,
  classificationKey,
  isPolicyConflict,
  rejectionIssues,
  unavailableKind,
  useClassificationWrites,
  useWorkPolicy,
  useWorkStatus,
} from "./use-classification";
import "./classification.css";

/** What every tab that edits the shared policy draft receives. */
export interface PolicyEditorProps {
  /** The server's copy: the saved draft and its publication state. */
  policy: WorkPolicy;
  /** The draft being edited on this screen. */
  draft: WorkPolicyConfig;
  onChange: (next: WorkPolicyConfig) => void;
  canWrite: boolean;
  writeReason?: string;
  issues: readonly WorkPolicyIssue[];
}

export function ClassificationPage(): React.JSX.Element {
  const policy = useWorkPolicy();
  const writes = useClassificationWrites();
  const queryClient = useQueryClient();
  const refreshInterval = useRefreshInterval();
  const [params, update] = useSearchState();
  const [tab] = useTabParam<ClassificationTabId>(classificationTabIds);
  const status = useWorkStatus(tab === "status" ? refreshInterval : false);

  // The edit starts from one revision of the stored draft and is saved on top of
  // it; a newer save by someone else is a conflict, never a silent overwrite.
  const [draft, setDraft] = useState<WorkPolicyConfig | null>(null);
  const [base, setBase] = useState<{ revision: number; fingerprint: string } | null>(null);
  const [issues, setIssues] = useState<WorkPolicyIssue[]>([]);
  const [conflict, setConflict] = useState(false);
  const saveRef = useRef<HTMLButtonElement>(null);

  const server = policy.data;
  const serverFingerprint = useMemo(() => (server ? configFingerprint(server.config) : ""), [server]);
  const draftFingerprint = useMemo(() => (draft ? configFingerprint(draft) : ""), [draft]);
  const dirty = draft !== null && base !== null && draftFingerprint !== base.fingerprint;

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

  const discard = (): void => {
    if (!server) return;
    setDraft(server.config);
    setBase({ revision: server.revision, fingerprint: serverFingerprint });
    setIssues([]);
    setConflict(false);
  };

  // Leaving the page (or closing the tab) with unsaved changes asks first, through
  // the console's shared unsaved-changes coordinator.
  useDraftGuard({
    dirty,
    keepMounted: true,
    // Tabs, filters and the open category live in the query string; changing them keeps the draft.
    keepsDraftOnSamePage: true,
    externalPending: writes.save.isPending,
    onDiscard: discard,
  });

  /** Opens a tab and drops the query keys that belonged to the tab being left. */
  const setTab = (id: ClassificationTabId, extra: SearchUpdates = {}): void => {
    const cleared: Record<string, undefined> = {};
    for (const key of tabScopedQueryKeys) cleared[key] = undefined;
    update({ ...cleared, tab: id === classificationTabIds[0] ? undefined : id, ...extra });
  };

  const changes = useMemo(
    () => (server && draft && dirty ? changeSummary(server.config, draft) : []),
    [server, draft, dirty],
  );

  const issueCounts = useMemo(() => {
    const counts: Partial<Record<ClassificationTabId, number>> = {};
    for (const issue of issues) {
      const tabId = issueTab(issue);
      counts[tabId] = (counts[tabId] ?? 0) + 1;
    }
    return counts;
  }, [issues]);

  const change = (next: WorkPolicyConfig): void => {
    // Issue paths index into the lists; once a list changes length they point elsewhere.
    if (
      draft &&
      issues.length > 0 &&
      (next.categories.length !== draft.categories.length ||
        next.action_types.length !== draft.action_types.length ||
        next.baselines.length !== draft.baselines.length)
    )
      setIssues([]);
    setDraft(next);
  };

  const reload = (): void => {
    setConflict(false);
    setIssues([]);
    setDraft(null);
    setBase(null);
    void queryClient.invalidateQueries({ queryKey: [...classificationKey, "policy"] });
  };

  const save = (): void => {
    if (!draft || !base) return;
    setConflict(false);
    // Problems the console can see itself are shown without a round trip.
    const local = localIssues(draft);
    setIssues(local);
    if (local.length > 0) return;
    writes.save.mutate(
      { config: draft, expectedRevision: base.revision, reason: "" },
      {
        onSuccess: (result) => {
          setDraft(result.config);
          setBase({ revision: result.revision, fingerprint: configFingerprint(result.config) });
        },
        onError: (error) => {
          setIssues(rejectionIssues(error) ?? []);
          setConflict(isPolicyConflict(error));
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

  const canWrite = writes.access.allowed;
  const editor: PolicyEditorProps | null =
    server && draft
      ? { policy: server, draft, onChange: change, canWrite, writeReason: writes.access.reason, issues }
      : null;
  const notImplemented =
    unavailableKind(policy.error) === "not_implemented" ||
    unavailableKind(status.error) === "not_implemented";
  const rawVersion = Number(params.get("version"));
  const openVersion = Number.isInteger(rawVersion) && rawVersion > 0 ? rawVersion : undefined;

  const policyProblem = (): React.JSX.Element =>
    policy.isError ? (
      <LoadProblem error={policy.error} subject="분류 정책" onRetry={() => void policy.refetch()} />
    ) : (
      <p className="wc-muted">분류 정책을 불러오는 중…</p>
    );

  return (
    <div className="page-stack wc-page">
      <PageHeader
        title="업무 분류 관리"
        description="AI 요청을 업무 카테고리로 나누는 분류 정책을 관리합니다. 카테고리와 규칙을 초안에서 고치고, 시험해 본 뒤 배포하며, 분류가 애매했던 요청을 검토·보정합니다."
        status="preview"
        readOnly={!canWrite}
        actions={
          <Button onClick={() => void queryClient.invalidateQueries({ queryKey: [...classificationKey] })}>
            <RefreshCw aria-hidden="true" /> 새로고침
          </Button>
        }
      />

      {notImplemented ? (
        <LoadProblem error={policy.error ?? status.error} subject="업무 분류" onRetry={() => undefined} />
      ) : (
        <>
          {!canWrite ? (
            <InlineNotice tone="info" title="읽기 전용입니다.">
              {writes.access.reason ?? "이 화면에서는 변경할 수 없습니다."} 정책과 대기열은 볼 수 있지만
              저장·배포·보정· 재분류는 할 수 없습니다.
            </InlineNotice>
          ) : null}

          {conflict ? (
            <InlineNotice tone="warning" title="다른 운영자가 먼저 저장했습니다.">
              <p>
                지금 편집 중인 내용은 저장되지 않았습니다. 최신 초안을 불러오면 이 화면의 변경은 사라지니,
                필요한 변경을 기억해 두고 다시 적용하세요.
              </p>
              <Button onClick={reload}>
                <RotateCcw aria-hidden="true" /> 최신 설정 불러오기
              </Button>
            </InlineNotice>
          ) : null}

          {issues.length > 0 && draft ? (
            <InlineNotice tone="danger" title={`정책 오류 ${issues.length}건 — 저장하지 않았습니다.`}>
              <ul className="wc-issue-list">
                {issues.slice(0, 20).map((issue) => (
                  <li key={`${issue.path}:${issue.message}`}>
                    <button
                      type="button"
                      className="wc-link-button"
                      onClick={() => {
                        const categoryId = issueCategoryId(issue, draft);
                        if (categoryId) setTab("categories", { category: categoryId });
                        else setTab(issueTab(issue));
                      }}
                    >
                      {issueLocation(issue, draft)}
                    </button>
                    : {issue.message}
                  </li>
                ))}
                {issues.length > 20 ? <li>외 {issues.length - 20}건</li> : null}
              </ul>
            </InlineNotice>
          ) : null}

          <div className="page-tabs">
            <Tabs
              ariaLabel="업무 분류 관리 화면 탭"
              items={classificationTabIds.map((id) => ({
                id,
                label: classificationTabLabels[id],
                badge: issueCounts[id] ? <span className="wc-tab-issues">{issueCounts[id]}</span> : undefined,
              }))}
              onChange={(id) => setTab(id)}
              panelIdPrefix="wc"
              value={tab}
            />
            <TabPanel id={tab} panelIdPrefix="wc" className="page-stack">
              {tab === "status" ? (
                status.data ? (
                  <StatusTab status={status.data} />
                ) : status.isError ? (
                  <LoadProblem
                    error={status.error}
                    subject="분류 상태"
                    onRetry={() => void status.refetch()}
                  />
                ) : (
                  <p className="wc-muted">분류 상태를 불러오는 중…</p>
                )
              ) : !editor ? (
                policyProblem()
              ) : (
                <>
                  {tab === "categories" ? (
                    <CategoriesTab
                      {...editor}
                      selectedId={params.get("category") ?? ""}
                      onSelect={(id) => update({ category: id || undefined })}
                    />
                  ) : null}
                  {tab === "policy" ? (
                    <PolicyTab
                      {...editor}
                      dirty={dirty}
                      writes={writes}
                      openVersion={openVersion}
                      onOpenVersion={(version) => update({ version }, { replace: version === undefined })}
                      onReload={reload}
                    />
                  ) : null}
                  {tab === "test" ? (
                    <TestTab
                      policy={editor.policy}
                      draft={editor.draft}
                      dirty={dirty}
                      status={status.data}
                      canRun={writes.hasWriteScope}
                      runReason="분류 테스트는 admin:write 권한이 필요합니다."
                    />
                  ) : null}
                  {tab === "review" ? (
                    <ReviewTab
                      policy={editor.policy}
                      writes={writes}
                      canWrite={canWrite}
                      writeReason={writes.access.reason}
                    />
                  ) : null}
                  {tab === "reclassify" ? (
                    <ReclassifyTab
                      policy={editor.policy}
                      writes={writes}
                      canWrite={canWrite}
                      writeReason={writes.access.reason}
                    />
                  ) : null}
                  {tab === "baselines" ? <BaselinesTab {...editor} /> : null}
                </>
              )}
            </TabPanel>
          </div>

          {editor && canWrite ? (
            <form
              className="wc-save-form"
              onSubmit={(event) => {
                event.preventDefault();
                save();
              }}
            >
              <StickySaveBar label="분류 정책 초안 저장" dirty={dirty} pending={writes.save.isPending}>
                {dirty ? (
                  <span className="wc-change-summary" title={changes.join("\n")}>
                    {changes.length > 0 ? changes.join(" · ") : "순서·표기 변경"}
                  </span>
                ) : null}
                <span className="wc-muted wc-revision">
                  {base && base.revision > 0 ? `초안 리비전 ${base.revision}` : "아직 저장된 적 없음"}
                </span>
                <Button type="button" disabled={!dirty || writes.save.isPending} onClick={discard}>
                  <RotateCcw aria-hidden="true" /> 되돌리기
                </Button>
                <Button
                  ref={saveRef}
                  type="submit"
                  variant="primary"
                  title="Ctrl+S — 초안만 저장합니다. 분류에 쓰려면 정책·버전 탭에서 배포하세요."
                  aria-keyshortcuts="Control+S Meta+S"
                  disabled={!dirty || writes.save.isPending}
                >
                  <Save aria-hidden="true" /> 저장
                </Button>
              </StickySaveBar>
            </form>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A read that failed: an API that is not there, a feature that is off, or an error to retry. */
function LoadProblem({
  error,
  subject,
  onRetry,
}: {
  error: unknown;
  subject: string;
  onRetry: () => void;
}): React.JSX.Element {
  const kind = unavailableKind(error);
  if (kind === "not_implemented") {
    return (
      <InlineNotice tone="warning" title="이 게이트웨이에는 업무 분류 기능이 아직 없습니다.">
        게이트웨이가 업무 분류 API에 「구현되지 않음(501)」으로 답했습니다. 업무 인텔리전스가 포함된 버전으로
        게이트웨이를 올리면 이 화면을 쓸 수 있습니다. 그때까지는 아무것도 바뀌지 않습니다.
      </InlineNotice>
    );
  }
  if (kind === "disabled") {
    return (
      <InlineNotice
        tone="warning"
        title="업무 분류 기능이 꺼져 있습니다."
        actions={
          <Link className="button button-secondary button-small" to={workIntelSettingsLink}>
            <Settings aria-hidden="true" /> 시스템 설정 열기
          </Link>
        }
      >
        시스템 설정의 WORK_INTEL_CLASSIFY_ENABLED · WORK_INTEL_ANALYTICS_ENABLED 를 켜면 다시 쓸 수 있습니다.
        재시작은 필요하지 않습니다.
      </InlineNotice>
    );
  }
  return (
    <InlineNotice
      tone="danger"
      title={`${subject} 정보를 불러오지 못했습니다.`}
      actions={<Button onClick={onRetry}>다시 시도</Button>}
    >
      {classificationErrorMessage(error, "잠시 후 다시 시도하세요.")}
    </InlineNotice>
  );
}
