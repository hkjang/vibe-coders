import {
  ArrowLeft,
  Braces,
  CircleAlert,
  GitFork,
  Plus,
  Save,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import type {
  DynamicRouteGraph,
  DynamicRouteIssue,
  DynamicRouteValidation,
} from "@/shared/api/domains/routing-dynamic";
import { isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { CopyButton } from "@/shared/components/ui/CopyButton";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Switch } from "@/shared/components/ui/Switch";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { Textarea } from "@/shared/components/ui/Textarea";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime } from "@/shared/utils/format";

import { DynamicRouteActivityPanel } from "./DynamicRouteActivity";
import { DynamicRouteFlow, type FlowIssueMarks } from "./DynamicRouteFlow";
import { DynamicRouteInspector } from "./DynamicRouteInspector";
import { DynamicRouteSimulator } from "./DynamicRouteSimulator";
import { DynamicRouteUsage } from "./DynamicRouteUsage";
import { DynamicRouteVersions } from "./DynamicRouteVersions";
import {
  addElement,
  addableTypes,
  elementTypeLabels,
  graphText,
  parseGraphText,
  sameGraph,
} from "./dynamic-route-model";
import { dynamicRoutesBasePath, DynamicRouteStateBadge } from "./DynamicRoutesPage";
import {
  dynamicRouteErrorMessage,
  dynamicRoutesKey,
  rejectionValidation,
  useDynamicRouteDetail,
  useDynamicRouteValidation,
  useDynamicRouteWrites,
} from "./use-dynamic-routes";

type TabId = "edit" | "simulate" | "versions" | "activity" | "usage";
const tabs: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: "edit", label: "흐름 편집" },
  { id: "simulate", label: "시뮬레이션" },
  { id: "versions", label: "버전·배포" },
  { id: "activity", label: "트래픽" },
  { id: "usage", label: "호출 방법" },
];

interface Draft {
  /** The version the edit started from; a save is refused if another landed since. */
  base: number;
  baseGraph: DynamicRouteGraph;
  graph: DynamicRouteGraph;
}

function issueMarks(validation: DynamicRouteValidation | undefined): FlowIssueMarks {
  return {
    errors: new Set(
      (validation?.errors ?? []).flatMap((issue) => (issue.element_id ? [issue.element_id] : [])),
    ),
    warnings: new Set(
      (validation?.warnings ?? []).flatMap((issue) => (issue.element_id ? [issue.element_id] : [])),
    ),
  };
}

export function DynamicRouteEditor({ id }: { id: string }): React.JSX.Element {
  const detail = useDynamicRouteDetail(id);
  const writes = useDynamicRouteWrites();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [tab, setTab] = useState<TabId>("edit");
  const [draft, setDraft] = useState<Draft>();
  const [selected, setSelected] = useState<string>("start");
  const [jsonMode, setJsonMode] = useState(false);
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState<string>();
  const [note, setNote] = useState("");
  const [rejection, setRejection] = useState<DynamicRouteValidation>();
  const [conflict, setConflict] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saved, setSaved] = useState<string>();
  const deleteRef = useRef<HTMLButtonElement>(null);

  const route = detail.data?.route;
  const latest = detail.data?.latest;
  const latestGraph = latest?.graph;
  const latestVersion = route?.latest_version ?? 0;
  // Follow the server's latest version while nothing is being edited, so a save
  // (here or by a colleague) shows up without a reload. Unsaved edits are kept.
  const [adoptedKey, setAdoptedKey] = useState<string>();
  const latestKey = latestGraph ? `${latestVersion}:${JSON.stringify(latestGraph.elements)}` : undefined;
  if (latestGraph && latestKey !== adoptedKey) {
    setAdoptedKey(latestKey);
    if (!draft || sameGraph(draft.graph, draft.baseGraph)) {
      setDraft({ base: latestVersion, baseGraph: latestGraph, graph: latestGraph });
    }
  }

  const graph = draft?.graph;
  const dirty = draft !== undefined && !sameGraph(draft.graph, draft.baseGraph);
  const stale = draft !== undefined && route !== undefined && draft.base !== route.latest_version;
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent): void => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const validationQuery = useDynamicRouteValidation(graph);
  const validation = validationQuery.data?.validation ?? rejection;
  const marks = useMemo(() => issueMarks(validation), [validation]);
  const selectedElement = graph?.elements.find((element) => element.id === selected);
  const byElement = (list: readonly DynamicRouteIssue[] | undefined): DynamicRouteIssue[] =>
    (list ?? []).filter((issue) => issue.element_id === selected);
  const graphIssues = (validation?.errors ?? []).filter((issue) => !issue.element_id);
  const readOnly = !writes.access.allowed;

  const change = (next: DynamicRouteGraph, select?: string): void => {
    setDraft((current) => (current ? { ...current, graph: next } : current));
    setRejection(undefined);
    setSaved(undefined);
    if (select !== undefined) setSelected(select || "start");
    if (jsonMode) setJsonText(graphText(next));
  };

  const save = async (deploy: boolean): Promise<void> => {
    if (!draft || !route) return;
    setRejection(undefined);
    setConflict(false);
    try {
      const result = await writes.saveVersion.mutateAsync({
        id,
        baseVersion: draft.base,
        graph: draft.graph,
        note: note.trim(),
        deploy,
      });
      setNote("");
      setSaved(
        deploy
          ? `v${result.route.latest_version}을 저장하고 배포했습니다.`
          : `v${result.route.latest_version}으로 저장했습니다. 배포 전까지 트래픽에는 영향이 없습니다.`,
      );
      if (result.version?.graph) {
        setDraft({
          base: result.route.latest_version,
          baseGraph: result.version.graph,
          graph: result.version.graph,
        });
      }
      await client.invalidateQueries({ queryKey: [...dynamicRoutesKey, "detail", id] });
    } catch (error) {
      const validationError = rejectionValidation(error);
      if (validationError) setRejection(validationError);
      if (isAppError(error) && error.code === "dynamic_route_conflict") setConflict(true);
    }
  };

  if (detail.isPending) {
    return (
      <div className="page-stack dynamic-routes">
        <p role="status">동적 경로를 불러오는 중…</p>
      </div>
    );
  }
  if (detail.isError || !route) {
    const missing = isAppError(detail.error) && detail.error.status === 404;
    return (
      <div className="page-stack dynamic-routes">
        <EmptyState
          title={missing ? "경로를 찾을 수 없습니다." : "경로를 불러오지 못했습니다."}
          description={
            missing
              ? "이미 삭제되었을 수 있습니다."
              : safeAppErrorMessage(detail.error, "잠시 후 다시 시도하세요.")
          }
          actions={
            <Link className="button button-secondary button-default" to={dynamicRoutesBasePath}>
              <ArrowLeft aria-hidden="true" /> 목록으로
            </Link>
          }
        />
      </div>
    );
  }

  return (
    <div className="page-stack dynamic-routes">
      <PageHeader
        eyebrow={
          <Link className="dr-back" to={dynamicRoutesBasePath}>
            <ArrowLeft aria-hidden="true" /> 동적 라우팅
          </Link>
        }
        title={route.name}
        description={route.description || "설명이 없습니다."}
        status="preview"
        readOnly={readOnly}
        actions={
          <>
            <Switch
              checked={route.enabled}
              label={route.enabled ? "사용 중" : "사용 중지됨"}
              disabled={readOnly || writes.update.isPending}
              onCheckedChange={(enabled) =>
                void writes.update.mutateAsync({ id, enabled }).catch(() => undefined)
              }
            />
            <Button ref={deleteRef} variant="danger" disabled={readOnly} onClick={() => setDeleting(true)}>
              <Trash2 aria-hidden="true" /> 삭제
            </Button>
          </>
        }
      />

      <div className="dr-summary" role="group" aria-label="경로 요약">
        <DynamicRouteStateBadge route={route} />
        <span className="dr-summary-item">
          호출 모델 <code>{route.call_model}</code>{" "}
          <CopyButton value={route.call_model} label="호출 모델 복사" size="icon" />
        </span>
        <span className="dr-summary-item">
          배포 {route.deployed_version > 0 ? `v${route.deployed_version}` : "없음"} · 최신 v
          {route.latest_version}
        </span>
        {route.deployed_at ? (
          <span className="dr-summary-item dr-muted">
            마지막 배포 <time dateTime={route.deployed_at}>{formatDateTime(route.deployed_at)}</time>
          </span>
        ) : null}
      </div>

      {route.state === "not_deployed" ? (
        <InlineNotice tone="warning" title="아직 배포하지 않았습니다.">
          저장한 버전은 배포 전까지 트래픽을 받지 않습니다. 시뮬레이션으로 확인한 뒤 버전·배포 탭에서
          배포하세요.
        </InlineNotice>
      ) : null}
      {!route.enabled ? (
        <InlineNotice tone="danger" title="사용 중지된 경로입니다.">
          {route.call_model} 호출은 dynamic_route_disabled 오류로 거절됩니다.
        </InlineNotice>
      ) : null}

      <Tabs
        ariaLabel="동적 경로 화면"
        items={tabs}
        value={tab}
        onChange={setTab}
        panelIdPrefix="dynamic-route"
      />

      <TabPanel id={tab} panelIdPrefix="dynamic-route">
        {tab === "edit" && graph ? (
          <div className="dr-edit">
            {stale ? (
              <InlineNotice
                tone="warning"
                title="편집하는 동안 새 버전이 저장되었습니다."
                actions={
                  <Button
                    size="small"
                    onClick={() =>
                      latestGraph &&
                      setDraft({ base: route.latest_version, baseGraph: latestGraph, graph: latestGraph })
                    }
                  >
                    최신 버전 불러오기 (내 변경 버림)
                  </Button>
                }
              >
                지금 저장하면 충돌로 거절됩니다. 최신 버전을 불러와 다시 적용하세요.
              </InlineNotice>
            ) : null}
            {conflict && !stale ? (
              <InlineNotice tone="warning" title="다른 운영자가 먼저 저장했습니다.">
                새로고침해서 최신 내용을 확인한 뒤 변경을 다시 적용하세요.
              </InlineNotice>
            ) : null}
            <div className="dr-toolbar" role="toolbar" aria-label="경로 편집 도구">
              {addableTypes.map((type) => (
                <Button
                  key={type}
                  size="small"
                  disabled={readOnly}
                  onClick={() => {
                    const added = addElement(graph, type);
                    change(added.graph, added.id);
                  }}
                >
                  <Plus aria-hidden="true" /> {elementTypeLabels[type]}
                </Button>
              ))}
              <span className="dr-toolbar-spacer" />
              <Button
                size="small"
                variant="ghost"
                aria-pressed={jsonMode}
                onClick={() => {
                  setJsonText(graphText(graph));
                  setJsonError(undefined);
                  setJsonMode(!jsonMode);
                }}
              >
                <Braces aria-hidden="true" /> {jsonMode ? "흐름으로 보기" : "JSON 편집"}
              </Button>
              <Button
                size="small"
                variant="ghost"
                disabled={!dirty}
                onClick={() => draft && change(draft.baseGraph, "start")}
              >
                변경 취소
              </Button>
            </div>

            <ValidationSummary
              validation={validation}
              pending={validationQuery.isFetching}
              failed={validationQuery.isError}
              graphIssues={graphIssues}
              onSelect={(elementId) => {
                setJsonMode(false);
                setSelected(elementId);
              }}
            />

            {jsonMode ? (
              <FormField
                label="경로 JSON"
                error={jsonError}
                description="Cloudflare AI Gateway 동적 라우팅 JSON과 같은 형식입니다. 고치면 흐름에 바로 반영됩니다."
              >
                {(control) => (
                  <Textarea
                    {...control}
                    className="dr-code"
                    rows={24}
                    spellCheck={false}
                    readOnly={readOnly}
                    value={jsonText}
                    onChange={(event) => {
                      setJsonText(event.target.value);
                      const parsed = parseGraphText(event.target.value);
                      setJsonError(parsed.error);
                      if (parsed.graph) {
                        setDraft((current) =>
                          current ? { ...current, graph: parsed.graph as DynamicRouteGraph } : current,
                        );
                        setRejection(undefined);
                      }
                    }}
                  />
                )}
              </FormField>
            ) : (
              <div className="dr-edit-columns">
                <DynamicRouteFlow
                  graph={graph}
                  label={`${route.name} 경로 흐름. 요소를 선택하면 오른쪽에서 설정합니다.`}
                  selectedId={selected}
                  onSelect={setSelected}
                  issues={marks}
                />
                {selectedElement ? (
                  <DynamicRouteInspector
                    key={selectedElement.id}
                    graph={graph}
                    element={selectedElement}
                    fields={detail.data.fields}
                    errors={byElement(validation?.errors)}
                    warnings={byElement(validation?.warnings)}
                    readOnly={readOnly}
                    onChange={change}
                  />
                ) : (
                  <p className="dr-hint">흐름에서 요소를 선택하세요.</p>
                )}
              </div>
            )}

            <SectionCard
              title="저장"
              description={
                dirty
                  ? "저장하면 새 버전이 생깁니다. 배포하기 전까지 트래픽에는 영향이 없습니다."
                  : "저장할 변경이 없습니다."
              }
            >
              <div className="dr-save">
                <FormField
                  label="변경 메모"
                  description="버전 목록에 남습니다. 예: 폴백 모델을 gpt-4.1-mini로 교체"
                >
                  {(control) => (
                    <Input
                      {...control}
                      value={note}
                      maxLength={200}
                      disabled={readOnly}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  )}
                </FormField>
                <div className="dr-save-actions">
                  <Button
                    disabled={
                      readOnly ||
                      !dirty ||
                      writes.saveVersion.isPending ||
                      (validation?.errors.length ?? 0) > 0
                    }
                    onClick={() => void save(false)}
                  >
                    <Save aria-hidden="true" /> 새 버전으로 저장
                  </Button>
                  <Button
                    variant="primary"
                    disabled={
                      readOnly ||
                      !dirty ||
                      writes.saveVersion.isPending ||
                      (validation?.errors.length ?? 0) > 0
                    }
                    onClick={() => void save(true)}
                  >
                    <Upload aria-hidden="true" /> 저장하고 배포
                  </Button>
                </div>
              </div>
              {saved ? (
                <InlineNotice tone="success" title={saved}>
                  버전·배포 탭에서 언제든 이전 버전으로 되돌릴 수 있습니다.
                </InlineNotice>
              ) : null}
              {writes.saveVersion.isError && !rejection && !conflict ? (
                <InlineNotice tone="danger" title="저장하지 못했습니다.">
                  {dynamicRouteErrorMessage(writes.saveVersion.error)}
                </InlineNotice>
              ) : null}
            </SectionCard>
          </div>
        ) : null}

        {tab === "simulate" && graph ? (
          <DynamicRouteSimulator routeId={route.id} graph={graph} dirty={dirty} />
        ) : null}
        {tab === "versions" ? (
          <DynamicRouteVersions
            route={route}
            versions={detail.data.versions}
            writes={writes}
            dirty={dirty}
            onLoad={(loaded, version) => {
              change(loaded, "start");
              setNote(`v${version}에서 가져옴`);
              setTab("edit");
            }}
          />
        ) : null}
        {tab === "activity" ? <DynamicRouteActivityPanel routeId={route.id} graph={graph} /> : null}
        {tab === "usage" ? <DynamicRouteUsage callModel={route.call_model} /> : null}
      </TabPanel>

      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        returnFocusRef={deleteRef}
        tone="danger"
        title="동적 경로 삭제"
        description={`${route.call_model} 호출이 바로 실패합니다. 모든 버전과 한도 집계가 지워지며 되돌릴 수 없습니다. 지난 요청 기록은 보존 기간 동안 남습니다.`}
        confirmLabel="삭제"
        requireTarget={route.name}
        onConfirm={async () => {
          await writes.remove.mutateAsync(id);
          void navigate(dynamicRoutesBasePath);
        }}
      />
    </div>
  );
}

function ValidationSummary({
  validation,
  pending,
  failed,
  graphIssues,
  onSelect,
}: {
  validation: DynamicRouteValidation | undefined;
  pending: boolean;
  failed: boolean;
  graphIssues: readonly DynamicRouteIssue[];
  onSelect: (elementId: string) => void;
}): React.JSX.Element {
  const errors = validation?.errors ?? [];
  const warnings = validation?.warnings ?? [];
  if (failed) {
    return (
      <p className="dr-validation dr-validation-unknown" role="status">
        <TriangleAlert aria-hidden="true" /> 검증 서버에 연결하지 못했습니다. 저장할 때 다시 검사합니다.
      </p>
    );
  }
  if (!validation) {
    return (
      <p className="dr-validation" role="status">
        검사하는 중…
      </p>
    );
  }
  if (errors.length === 0 && warnings.length === 0) {
    return (
      <p className="dr-validation dr-validation-ok" role="status">
        <GitFork aria-hidden="true" /> 오류가 없습니다{pending ? " (다시 검사하는 중…)" : ""}.
      </p>
    );
  }
  return (
    <div className="dr-validation" role="status" aria-live="polite">
      <p>
        {errors.length > 0 ? (
          <strong className="dr-validation-error">
            <CircleAlert aria-hidden="true" /> 오류 {errors.length}개 — 고쳐야 저장할 수 있습니다.
          </strong>
        ) : null}{" "}
        {warnings.length > 0 ? <span className="dr-validation-warning">경고 {warnings.length}개</span> : null}
        {pending ? <span className="dr-muted"> · 다시 검사하는 중…</span> : null}
      </p>
      <ul className="dr-plain-list">
        {graphIssues.map((issue) => (
          <li key={`g:${issue.code}`}>{issue.message}</li>
        ))}
        {[...errors, ...warnings]
          .filter((issue) => issue.element_id)
          .map((issue) => (
            <li key={`${issue.element_id}:${issue.code}:${issue.message}`}>
              <button
                type="button"
                className="dr-link-button"
                onClick={() => onSelect(issue.element_id ?? "start")}
              >
                {issue.element_id}
              </button>{" "}
              {issue.message}
            </li>
          ))}
      </ul>
    </div>
  );
}
