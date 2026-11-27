import { History, Plus, RotateCcw, Trash2, UploadCloud } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import type {
  WorkActionType,
  WorkPolicyConfig,
  WorkPolicyVersionRow,
  WorkPublishResult,
} from "@/shared/api/domains/insights-classification";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { Textarea } from "@/shared/components/ui/Textarea";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

import type { PolicyEditorProps } from "./ClassificationPage";
import {
  changeDetails,
  changeSummary,
  idSegmentPattern,
  issueAt,
  thresholdLabels,
} from "./classification-model";
import { ListField, NumberField } from "./fields";
import {
  classificationErrorMessage,
  useWorkVersion,
  useWorkVersions,
  type useClassificationWrites,
} from "./use-classification";

interface PolicyTabProps extends PolicyEditorProps {
  /** The local draft has edits that are not saved yet. */
  dirty: boolean;
  writes: ReturnType<typeof useClassificationWrites>;
  /** The published version open in the detail panel (URL `version`). */
  openVersion: number | undefined;
  onOpenVersion: (version: number | undefined) => void;
  /** Drops the local draft and reads the server's copy again. */
  onReload: () => void;
}

const thresholdHelp: Readonly<Record<keyof typeof thresholdLabels, string>> = {
  accept:
    "규칙으로 낸 신뢰도가 이 값 이상이면 그대로 확정합니다. 높이면 더 많은 요청이 캐시·LLM·검토로 넘어갑니다. (0~1)",
  review_below:
    "최종 신뢰도가 이 값보다 낮으면 사람이 확인하도록 검토 대기열로 보냅니다. 0이면 검토로 보내지 않습니다. (0~1)",
  min_evidence:
    "한 카테고리에 서로 다른 근거가 이만큼 있어야 확정합니다. 키워드 하나만 맞았다고 확정되는 것을 막습니다. (1~10)",
  min_group_size:
    "고유 사용자 수가 이보다 적은 집계 칸은 값을 가립니다. 소수 인원의 활동이 통계에서 드러나지 않게 합니다. (1~50)",
};

export function PolicyTab({
  policy,
  draft,
  onChange,
  canWrite,
  writeReason,
  issues,
  dirty,
  writes,
  openVersion,
  onOpenVersion,
  onReload,
}: PolicyTabProps): React.JSX.Element {
  const versions = useWorkVersions();
  const triggerRef = useRef<HTMLElement | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [published, setPublished] = useState<WorkPublishResult | undefined>(undefined);
  const [rollbackTo, setRollbackTo] = useState<number | undefined>(undefined);
  // The published document is needed only to summarise what a publish would change.
  const publishedDoc = useWorkVersion(publishing ? policy.published_version : undefined);

  const lockTitle = canWrite ? undefined : writeReason;
  const neverPublished = policy.published_version === 0;
  const publishBlock = !canWrite
    ? writeReason
    : dirty
      ? "저장하지 않은 변경이 있습니다. 먼저 초안을 저장하세요."
      : !policy.dirty && !neverPublished
        ? "초안이 배포본과 같아 배포할 내용이 없습니다."
        : undefined;
  const savedActionIds = useMemo(
    () => new Set(policy.config.action_types.map((action) => action.id)),
    [policy.config.action_types],
  );

  const setThreshold = (key: keyof typeof thresholdLabels, value: number): void =>
    onChange({ ...draft, thresholds: { ...draft.thresholds, [key]: value } });
  const setAction = (index: number, patch: Partial<WorkActionType>): void =>
    onChange({
      ...draft,
      action_types: draft.action_types.map((action, at) => (at === index ? { ...action, ...patch } : action)),
    });
  const promptBytes = new TextEncoder().encode(draft.llm.system_prompt).length;

  return (
    <>
      <SectionCard
        headingLevel={3}
        title="초안과 배포"
        description="초안을 저장해도 분류는 바뀌지 않습니다. 배포해야 분류 엔진이 새 정책 버전으로 새 요청을 분류합니다."
        actions={
          <Button
            variant="primary"
            disabled={publishBlock !== undefined}
            title={publishBlock}
            onClick={(event) => {
              triggerRef.current = event.currentTarget;
              setPublishing(true);
            }}
          >
            <UploadCloud aria-hidden="true" /> 배포
          </Button>
        }
      >
        <div className="wc-state-badges">
          {dirty ? <Badge tone="warning">저장하지 않은 변경 있음</Badge> : <Badge>저장된 초안과 같음</Badge>}
          {neverPublished ? (
            <Badge tone="warning">아직 배포한 적 없음</Badge>
          ) : policy.dirty ? (
            <Badge tone="warning">초안이 배포본과 다름</Badge>
          ) : (
            <Badge tone="success">초안이 배포본과 같음</Badge>
          )}
        </div>
        <KeyValueList
          columns={2}
          items={[
            {
              label: "초안 리비전",
              value: policy.revision > 0 ? `리비전 ${policy.revision}` : "저장된 적 없음",
            },
            {
              label: "마지막 저장",
              value: policy.updated_at
                ? `${formatDateTime(policy.updated_at)}${policy.updated_by ? ` · ${policy.updated_by}` : ""}`
                : "",
            },
            {
              label: "배포된 정책 버전",
              value: neverPublished ? "없음" : `버전 ${policy.published_version}`,
            },
            { label: "배포 시각", value: policy.published_at ? formatDateTime(policy.published_at) : "" },
          ]}
        />
        {publishBlock && canWrite ? <p className="wc-muted wc-note">{publishBlock}</p> : null}
        {published ? (
          <InlineNotice tone="success" title={`정책 버전 ${published.version} 배포를 마쳤습니다.`}>
            삭제된 카테고리 {formatNumber(published.impact.categories_removed)}개 · 영향받는 요청{" "}
            {formatNumber(published.impact.affected_requests)}건. 새 요청부터 이 버전으로 분류합니다. 이미
            분류된 요청에 적용하려면 재분류 탭을 사용하세요.
          </InlineNotice>
        ) : null}
      </SectionCard>

      <SectionCard
        headingLevel={3}
        title="임계값"
        description="규칙 분류 결과를 언제 확정하고 언제 사람에게 넘길지, 통계에서 무엇을 가릴지 정합니다."
        actions={
          <Button
            size="small"
            variant="ghost"
            disabled={!canWrite}
            title={lockTitle}
            onClick={() =>
              onChange({ ...draft, thresholds: { ...draft.thresholds, ...policy.defaults.thresholds } })
            }
          >
            <RotateCcw aria-hidden="true" /> 기본값으로
          </Button>
        }
      >
        <fieldset className="wc-fieldset" disabled={!canWrite}>
          <legend className="sr-only">임계값</legend>
          <div className="wc-form-grid">
            <NumberField
              label={thresholdLabels.accept}
              description={thresholdHelp.accept}
              min={0}
              max={1}
              step={0.01}
              value={draft.thresholds.accept}
              error={issueAt(issues, "thresholds.accept")}
              onChange={(value) => setThreshold("accept", value)}
            />
            <NumberField
              label={thresholdLabels.review_below}
              description={thresholdHelp.review_below}
              min={0}
              max={1}
              step={0.01}
              value={draft.thresholds.review_below}
              error={issueAt(issues, "thresholds.review_below")}
              onChange={(value) => setThreshold("review_below", value)}
            />
            <NumberField
              label={thresholdLabels.min_evidence}
              description={thresholdHelp.min_evidence}
              min={1}
              max={10}
              step={1}
              value={draft.thresholds.min_evidence}
              error={issueAt(issues, "thresholds.min_evidence")}
              onChange={(value) => setThreshold("min_evidence", value)}
            />
            <NumberField
              label={thresholdLabels.min_group_size}
              description={thresholdHelp.min_group_size}
              min={1}
              max={50}
              step={1}
              value={draft.thresholds.min_group_size}
              error={issueAt(issues, "thresholds.min_group_size")}
              onChange={(value) => setThreshold("min_group_size", value)}
            />
          </div>
        </fieldset>
      </SectionCard>

      <SectionCard
        headingLevel={3}
        title="LLM 분류"
        description="규칙과 캐시로 확정하지 못한 요청을 분류 모델에 물을 때 쓰는 설정입니다. LLM 분류는 시스템 설정(WORK_INTEL_LLM_ENABLED)에서 켠 경우에만 쓰이며, 가린 텍스트와 카테고리 ID 목록만 보냅니다."
      >
        <fieldset className="wc-fieldset" disabled={!canWrite}>
          <legend className="sr-only">LLM 분류</legend>
          <FormField
            label="시스템 프롬프트"
            description={`분류 모델에 주는 지시문입니다. ${formatNumber(promptBytes)} / 8,000바이트`}
            error={issueAt(issues, "llm.system_prompt")}
          >
            {(control) => (
              <Textarea
                {...control}
                rows={8}
                value={draft.llm.system_prompt}
                spellCheck={false}
                onChange={(event) =>
                  onChange({ ...draft, llm: { ...draft.llm, system_prompt: event.target.value } })
                }
              />
            )}
          </FormField>
          <div className="wc-form-grid">
            <NumberField
              label="입력 글자 수 상한"
              description="가린 프롬프트에서 분류 모델에 보내는 최대 글자 수입니다. (200~8000)"
              min={200}
              max={8000}
              step={100}
              value={draft.llm.max_input_chars}
              error={issueAt(issues, "llm.max_input_chars")}
              onChange={(value) => onChange({ ...draft, llm: { ...draft.llm, max_input_chars: value } })}
            />
          </div>
        </fieldset>
      </SectionCard>

      <SectionCard
        headingLevel={3}
        title={`작업 유형 (${draft.action_types.length})`}
        description="사용자가 대상에 무엇을 하려 했는지(조회·분석·생성·수정 등)를 키워드로 판단합니다. 판단할 수 없으면 '알 수 없음'으로 둡니다."
        actions={
          <>
            <Button
              size="small"
              variant="ghost"
              disabled={!canWrite || policy.defaults.action_types.length === 0}
              title={lockTitle}
              onClick={() => onChange({ ...draft, action_types: policy.defaults.action_types })}
            >
              <RotateCcw aria-hidden="true" /> 기본값으로
            </Button>
            <Button
              size="small"
              disabled={!canWrite}
              title={lockTitle}
              onClick={() =>
                onChange({
                  ...draft,
                  action_types: [...draft.action_types, { id: "", name: "", keywords: [] }],
                })
              }
            >
              <Plus aria-hidden="true" /> 작업 유형 추가
            </Button>
          </>
        }
      >
        {issueAt(issues, "action_types") && draft.action_types.length === 0 ? (
          <p className="field-error" role="alert">
            {issueAt(issues, "action_types")}
          </p>
        ) : null}
        {draft.action_types.length === 0 ? (
          <EmptyState
            title="작업 유형이 없습니다."
            description="비워 두고 저장하면 서버가 기본 작업 유형으로 채웁니다."
          />
        ) : (
          <fieldset className="wc-fieldset" disabled={!canWrite}>
            <legend className="sr-only">작업 유형</legend>
            <ul className="wc-card-list" aria-label="작업 유형 목록">
              {draft.action_types.map((action, index) => {
                const saved = savedActionIds.has(action.id);
                const path = `action_types[${index}]`;
                return (
                  <li key={index} className="wc-card">
                    <div className="wc-form-grid">
                      <FormField
                        label="ID"
                        description={
                          saved ? undefined : "영문 소문자·숫자·-·_ (저장 후에는 바꿀 수 없습니다)"
                        }
                        error={
                          issueAt(issues, `${path}.id`) ??
                          (action.id !== "" && !idSegmentPattern.test(action.id)
                            ? "영문 소문자·숫자·-·_ 만 쓸 수 있습니다."
                            : undefined)
                        }
                      >
                        {(control) => (
                          <Input
                            {...control}
                            className="wc-mono"
                            value={action.id}
                            readOnly={saved}
                            autoComplete="off"
                            spellCheck={false}
                            onChange={(event) =>
                              setAction(index, { id: event.target.value.trim().toLowerCase() })
                            }
                          />
                        )}
                      </FormField>
                      <FormField label="이름" error={issueAt(issues, `${path}.name`)}>
                        {(control) => (
                          <Input
                            {...control}
                            value={action.name}
                            maxLength={80}
                            onChange={(event) => setAction(index, { name: event.target.value })}
                          />
                        )}
                      </FormField>
                    </div>
                    <ListField
                      label="키워드"
                      rows={1}
                      value={action.keywords}
                      error={issueAt(issues, `${path}.keywords`)}
                      onChange={(keywords) => setAction(index, { keywords })}
                    />
                    <div className="wc-card-actions">
                      <Button
                        size="small"
                        variant="ghost"
                        aria-label={`작업 유형 ${action.name || action.id || index + 1} 삭제`}
                        onClick={() =>
                          onChange({
                            ...draft,
                            action_types: draft.action_types.filter((_, at) => at !== index),
                          })
                        }
                      >
                        <Trash2 aria-hidden="true" /> 삭제
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        )}
      </SectionCard>

      <SectionCard
        headingLevel={3}
        title="배포 버전"
        description="배포할 때마다 정책 전체가 버전으로 남습니다. 예전 버전의 내용을 새 버전으로 다시 배포(롤백)할 수 있습니다."
      >
        {versions.isPending ? (
          <p className="wc-muted">버전 목록을 불러오는 중…</p>
        ) : versions.isError ? (
          <InlineNotice
            tone="danger"
            title="버전 목록을 불러오지 못했습니다."
            actions={<Button onClick={() => void versions.refetch()}>다시 시도</Button>}
          >
            {classificationErrorMessage(versions.error, "잠시 후 다시 시도하세요.")}
          </InlineNotice>
        ) : versions.data.versions.length === 0 ? (
          <EmptyState
            icon={<History aria-hidden="true" />}
            title="아직 배포된 버전이 없습니다."
            description="초안을 저장한 뒤 「배포」하면 첫 버전이 만들어지고 분류에 쓰이기 시작합니다."
          />
        ) : (
          <ul className="wc-card-list" aria-label="배포 버전 목록">
            {versions.data.versions.map((row) => (
              <VersionRow
                key={row.version}
                row={row}
                current={row.version === policy.published_version}
                canWrite={canWrite}
                lockTitle={lockTitle}
                rollbackBlocked={row.version === policy.published_version && !policy.dirty && !dirty}
                onOpen={(trigger) => {
                  triggerRef.current = trigger;
                  onOpenVersion(row.version);
                }}
                onRollback={(trigger) => {
                  triggerRef.current = trigger;
                  setRollbackTo(row.version);
                }}
              />
            ))}
          </ul>
        )}
      </SectionCard>

      <ConfirmDialog
        open={publishing}
        onOpenChange={setPublishing}
        returnFocusRef={triggerRef}
        title="정책 배포"
        confirmLabel="배포"
        description={`저장된 초안(리비전 ${policy.revision})을 새 정책 버전으로 배포합니다. 배포한 뒤 들어오는 요청부터 새 버전으로 분류합니다.`}
        requireReason
        errorFormatter={classificationErrorMessage}
        onConfirm={async (note) => {
          const result = await writes.publish.mutateAsync({ expectedRevision: policy.revision, note });
          setPublished(result);
        }}
      >
        <PublishSummary
          neverPublished={neverPublished}
          categories={policy.config.categories.length}
          publishedVersion={policy.published_version}
          base={publishedDoc.data?.config}
          draft={policy.config}
          loading={publishedDoc.isPending && !neverPublished}
          failed={publishedDoc.isError}
        />
      </ConfirmDialog>

      <ConfirmDialog
        open={rollbackTo !== undefined}
        onOpenChange={(open) => {
          if (!open) setRollbackTo(undefined);
        }}
        returnFocusRef={triggerRef}
        tone="danger"
        title={`버전 ${rollbackTo ?? ""} 롤백`}
        confirmLabel="롤백"
        description={`버전 ${rollbackTo ?? ""}의 내용을 새 버전으로 배포하고 초안에도 반영합니다. 기존 버전 기록은 지워지지 않습니다.`}
        requireReason
        errorFormatter={classificationErrorMessage}
        onConfirm={async (note) => {
          if (rollbackTo === undefined) return;
          await writes.rollback.mutateAsync({ version: rollbackTo, note });
          setPublished(undefined);
          onOpenVersion(undefined);
          onReload();
        }}
      >
        <ul className="wc-plain-list">
          {dirty ? <li>이 화면에서 저장하지 않은 변경은 사라집니다.</li> : null}
          {policy.dirty ? <li>배포하지 않은 초안의 변경도 이 버전의 내용으로 덮어씁니다.</li> : null}
          <li>롤백한 뒤 들어오는 요청부터 이 내용으로 분류합니다. 이미 분류된 요청은 바뀌지 않습니다.</li>
        </ul>
      </ConfirmDialog>

      <VersionSheet
        version={openVersion}
        draft={draft}
        dirty={dirty}
        returnFocusRef={triggerRef}
        canRollback={canWrite}
        lockTitle={lockTitle}
        onClose={() => onOpenVersion(undefined)}
        onRollback={(version) => setRollbackTo(version)}
      />
    </>
  );
}

function PublishSummary({
  neverPublished,
  categories,
  publishedVersion,
  base,
  draft,
  loading,
  failed,
}: {
  neverPublished: boolean;
  categories: number;
  publishedVersion: number;
  base: WorkPolicyConfig | undefined;
  draft: WorkPolicyConfig;
  loading: boolean;
  failed: boolean;
}): React.JSX.Element {
  if (neverPublished) {
    return <p className="wc-note">첫 배포입니다. 카테고리 {categories}개가 분류에 쓰이기 시작합니다.</p>;
  }
  if (base) {
    const summary = changeSummary(base, draft);
    const details = changeDetails(base, draft);
    return (
      <div className="wc-publish-summary">
        <strong>
          버전 {publishedVersion} 대비 변경:{" "}
          {summary.length > 0 ? summary.join(" · ") : "분류에 영향 없는 변경"}
        </strong>
        {details.length > 0 ? (
          <ul className="wc-plain-list" aria-label="배포할 변경 내용">
            {details.slice(0, 30).map((line) => (
              <li key={line}>{line}</li>
            ))}
            {details.length > 30 ? <li>외 {details.length - 30}건</li> : null}
          </ul>
        ) : null}
      </div>
    );
  }
  if (loading) return <p className="wc-muted wc-note">배포본과 비교하는 중…</p>;
  return (
    <p className="wc-muted wc-note">
      {failed ? "배포본을 불러오지 못해 변경 요약을 표시할 수 없습니다. " : ""}
      배포하면 결과에 삭제된 카테고리 수와 영향받는 요청 수가 표시됩니다.
    </p>
  );
}

const changeKinds: readonly { key: keyof WorkPolicyVersionRow["changes"]; label: string }[] = [
  { key: "added", label: "추가" },
  { key: "removed", label: "삭제" },
  { key: "renamed", label: "이름 변경" },
  { key: "merged", label: "병합" },
  { key: "rules_changed", label: "규칙 변경" },
];

function VersionRow({
  row,
  current,
  canWrite,
  lockTitle,
  rollbackBlocked,
  onOpen,
  onRollback,
}: {
  row: WorkPolicyVersionRow;
  current: boolean;
  canWrite: boolean;
  lockTitle: string | undefined;
  rollbackBlocked: boolean;
  onOpen: (trigger: HTMLElement) => void;
  onRollback: (trigger: HTMLElement) => void;
}): React.JSX.Element {
  const kinds = changeKinds
    .map((kind) => ({ ...kind, ids: row.changes[kind.key] as string[] }))
    .filter((kind) => kind.ids.length > 0);
  return (
    <li className="wc-card" data-current={current || undefined}>
      <div className="wc-version-head">
        <strong>버전 {row.version}</strong>
        {current ? <Badge tone="success">현재 배포본</Badge> : null}
        <span className="wc-muted">
          {formatDateTime(row.published_at)}
          {row.published_by ? ` · ${row.published_by}` : ""} · 카테고리 {formatNumber(row.categories)}개
        </span>
      </div>
      {row.note ? <p className="wc-version-note">{row.note}</p> : null}
      {kinds.length > 0 ? (
        <details className="wc-changes">
          <summary>
            <span className="wc-chips">
              {kinds.map((kind) => (
                <span key={kind.key} className="wc-chip">
                  {kind.label} {kind.ids.length}
                </span>
              ))}
            </span>
          </summary>
          <dl className="wc-change-list">
            {kinds.map((kind) => (
              <div key={kind.key}>
                <dt>{kind.label}</dt>
                <dd>
                  <code>{kind.ids.join(", ")}</code>
                </dd>
              </div>
            ))}
          </dl>
        </details>
      ) : (
        <p className="wc-muted wc-note">이전 버전과 카테고리·규칙 차이가 없습니다.</p>
      )}
      <div className="wc-card-actions">
        <Button
          size="small"
          aria-label={`내용 보기 (버전 ${row.version})`}
          onClick={(event) => onOpen(event.currentTarget)}
        >
          내용 보기
        </Button>
        <Button
          size="small"
          variant="ghost"
          disabled={!canWrite || rollbackBlocked}
          aria-label={`이 버전으로 롤백 (버전 ${row.version})`}
          title={lockTitle ?? (rollbackBlocked ? "지금 배포본이며 초안도 같습니다." : undefined)}
          onClick={(event) => onRollback(event.currentTarget)}
        >
          <RotateCcw aria-hidden="true" /> 이 버전으로 롤백
        </Button>
      </div>
    </li>
  );
}

function VersionSheet({
  version,
  draft,
  dirty,
  returnFocusRef,
  canRollback,
  lockTitle,
  onClose,
  onRollback,
}: {
  version: number | undefined;
  draft: WorkPolicyConfig;
  dirty: boolean;
  returnFocusRef: React.RefObject<HTMLElement | null>;
  canRollback: boolean;
  lockTitle: string | undefined;
  onClose: () => void;
  onRollback: (version: number) => void;
}): React.JSX.Element {
  const detail = useWorkVersion(version);
  const doc = detail.data;
  const rows: { label: string; then: number; now: number }[] = doc
    ? [
        ...(Object.keys(thresholdLabels) as (keyof typeof thresholdLabels)[]).map((key) => ({
          label: thresholdLabels[key],
          then: doc.config.thresholds[key],
          now: draft.thresholds[key],
        })),
        {
          label: "LLM 입력 글자 수 상한",
          then: doc.config.llm.max_input_chars,
          now: draft.llm.max_input_chars,
        },
      ]
    : [];
  const differences = doc
    ? changeDetails(doc.config, draft).filter((line) => !/^(임계값|LLM)/u.test(line))
    : [];
  const samePrompt = doc ? doc.config.llm.system_prompt === draft.llm.system_prompt : true;
  const draftLabel = dirty ? "현재 초안 (저장 전 변경 포함)" : "현재 초안";
  return (
    <Sheet
      open={version !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      size="wide"
      title={`정책 버전 ${version ?? ""}`}
      description="배포된 버전의 내용을 현재 초안과 나란히 비교합니다."
      footer={
        <>
          <Button onClick={onClose}>닫기</Button>
          <Button
            variant="danger"
            disabled={!canRollback || !doc}
            title={lockTitle}
            onClick={() => {
              if (version !== undefined) onRollback(version);
            }}
          >
            <RotateCcw aria-hidden="true" /> 이 버전으로 롤백
          </Button>
        </>
      }
    >
      {detail.isError ? (
        <InlineNotice tone="danger" title="버전 내용을 불러오지 못했습니다.">
          {classificationErrorMessage(detail.error, "잠시 후 다시 시도하세요.")}
        </InlineNotice>
      ) : !doc ? (
        <p className="wc-muted">버전 내용을 불러오는 중…</p>
      ) : (
        <div className="wc-version-detail">
          <KeyValueList
            columns={2}
            items={[
              { label: "배포 시각", value: formatDateTime(doc.published_at) },
              { label: "배포한 사람", value: doc.published_by },
              { label: "메모", value: doc.note },
              { label: "카테고리 수", value: `${formatNumber(doc.config.categories.length)}개` },
            ]}
          />

          <section aria-labelledby="wc-version-thresholds">
            <h3 id="wc-version-thresholds" className="wc-subheading">
              임계값 비교
            </h3>
            <div className="data-table-scroll" tabIndex={0} aria-label="임계값 비교 표 영역">
              <table className="data-table">
                <caption className="sr-only">버전 {doc.version} · 현재 초안 임계값 비교</caption>
                <thead>
                  <tr>
                    <th scope="col">항목</th>
                    <th scope="col">버전 {doc.version}</th>
                    <th scope="col">{draftLabel}</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.label} data-changed={row.then !== row.now || undefined}>
                      <th scope="row">{row.label}</th>
                      <td>{row.then}</td>
                      <td>
                        {row.now}
                        {row.then !== row.now ? <Badge tone="warning">다름</Badge> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-labelledby="wc-version-prompt">
            <h3 id="wc-version-prompt" className="wc-subheading">
              LLM 시스템 프롬프트 비교{" "}
              {samePrompt ? <Badge tone="success">같음</Badge> : <Badge tone="warning">다름</Badge>}
            </h3>
            <div className="wc-compare">
              <figure>
                <figcaption>버전 {doc.version}</figcaption>
                <pre tabIndex={0} aria-label={`버전 ${doc.version}의 시스템 프롬프트`}>
                  {doc.config.llm.system_prompt || "(비어 있음)"}
                </pre>
              </figure>
              <figure>
                <figcaption>{draftLabel}</figcaption>
                <pre tabIndex={0} aria-label="현재 초안의 시스템 프롬프트">
                  {draft.llm.system_prompt || "(비어 있음)"}
                </pre>
              </figure>
            </div>
          </section>

          <section aria-labelledby="wc-version-categories">
            <h3 id="wc-version-categories" className="wc-subheading">
              이 버전에서 현재 초안까지 바뀐 카테고리·규칙
            </h3>
            {differences.length === 0 ? (
              <p className="wc-muted">카테고리와 규칙은 현재 초안과 같습니다.</p>
            ) : (
              <ul className="wc-plain-list">
                {differences.slice(0, 50).map((line) => (
                  <li key={line}>{line}</li>
                ))}
                {differences.length > 50 ? <li>외 {differences.length - 50}건</li> : null}
              </ul>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}
