import { useQueryClient } from "@tanstack/react-query";
import { Eye, Hammer, Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
  WorkJob,
  WorkPolicy,
  WorkRebuildResult,
  WorkReclassifyPreview,
} from "@/shared/api/domains/insights-classification";
import { workMethods, workStatuses } from "@/shared/api/domains/insights-common";
import { FormField } from "@/shared/components/form/FormField";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

import {
  categoryPath,
  daysRebuiltCount,
  jobFinished,
  jobProgress,
  jobStatusLabels,
  jobStatusTones,
  methodLabels,
  reclassifyConflictMessages,
  reclassifyFormFromParams,
  reclassifyFormProblem,
  reclassifyQuery,
  statusLabels,
  type ReclassifyConflict,
} from "./classification-model";
import { CategorySelect } from "./fields";
import {
  activeJobFrom,
  classificationErrorMessage,
  classificationKey,
  reclassifyConflict,
  useReclassifyPreview,
  useWorkJob,
  type useClassificationWrites,
} from "./use-classification";

interface ReclassifyTabProps {
  policy: WorkPolicy;
  writes: ReturnType<typeof useClassificationWrites>;
  canWrite: boolean;
  writeReason?: string;
}

export function ReclassifyTab({
  policy,
  writes,
  canWrite,
  writeReason,
}: ReclassifyTabProps): React.JSX.Element {
  const [params, update] = useSearchState();
  const queryClient = useQueryClient();
  // The default period is the week up to the day this tab was opened.
  const [openedAt] = useState(() => new Date());
  const form = reclassifyFormFromParams(params, openedAt);
  const problem = reclassifyFormProblem(form);
  const query = reclassifyQuery(form);
  const queryKey = JSON.stringify(query);
  // The job is kept in the URL so a reload finds it again; the local copy covers an
  // id the route's query policy would refuse to store.
  const [shownJob, setShownJob] = useState("");
  const jobId = params.get("job") ?? shownJob;
  const showJob = (id: string): void => {
    setShownJob(id);
    update({ job: id || undefined }, { replace: id === "" });
  };
  const categories = policy.config.categories;

  const preview = useReclassifyPreview();
  const job = useWorkJob(jobId);
  const [previewed, setPreviewed] = useState<{ key: string; data: WorkReclassifyPreview } | undefined>();
  const [conflict, setConflict] = useState<ReclassifyConflict | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const runRef = useRef<HTMLButtonElement>(null);

  const current = previewed?.key === queryKey ? previewed.data : undefined;
  const stale = previewed !== undefined && current === undefined;
  const activeJob =
    current?.active_job && !jobFinished(current.active_job.status) ? current.active_job : null;
  const jobRunning = job.data !== undefined && !jobFinished(job.data.status);
  const lockTitle = canWrite ? undefined : writeReason;

  // When a job ends, the queue and the worker status it changed are read again.
  const finishedStatus = job.data && jobFinished(job.data.status) ? job.data.status : "";
  useEffect(() => {
    if (!finishedStatus) return;
    void queryClient.invalidateQueries({ queryKey: [...classificationKey, "review"] });
    void queryClient.invalidateQueries({ queryKey: [...classificationKey, "status"] });
  }, [finishedStatus, queryClient]);

  const setField = (key: "from" | "to" | "status" | "category" | "method", value: string): void =>
    update({ [key]: value || undefined });

  const runPreview = async (): Promise<WorkReclassifyPreview | undefined> => {
    if (problem) return undefined;
    try {
      const data = await preview.mutateAsync(query);
      setPreviewed({ key: queryKey, data });
      return data;
    } catch {
      // The failure is already shown as a notification with its request ID.
      return undefined;
    }
  };

  const start = async (reason: string): Promise<void> => {
    if (!current) return;
    try {
      const started = await writes.reclassify.mutateAsync({
        revision: current.revision,
        reviewedAt: current.reviewed_at,
        reason,
      });
      setPreviewed(undefined);
      setConflict(undefined);
      showJob(started.id);
    } catch (error) {
      const kind = reclassifyConflict(error);
      if (!kind) throw error;
      // A refused run is not a failure of the dialog: close it and say what to do next.
      setConflict(kind);
      if (kind !== "job_active") {
        setPreviewed(undefined);
        return;
      }
      const active = activeJobFrom(error) ?? (await runPreview())?.active_job ?? undefined;
      if (active) showJob(active.id);
    }
  };

  const runBlock = !canWrite
    ? writeReason
    : !current
      ? stale
        ? "조건이 바뀌었습니다. 영향 미리보기를 다시 실행하세요."
        : "먼저 영향 미리보기를 실행하세요."
      : activeJob || jobRunning
        ? "진행 중인 재분류 작업이 있습니다."
        : current.total === 0
          ? "재분류할 요청이 없습니다."
          : undefined;

  return (
    <>
      <SectionCard
        headingLevel={3}
        title="재분류"
        description="이미 분류된 요청을 지금 배포된 정책으로 다시 분류합니다. 먼저 영향을 미리 본 뒤 실행하며, 관리자가 보정한 요청은 바꾸지 않습니다."
      >
        <div className="wc-filter-grid">
          <FormField label="시작일">
            {(control) => (
              <Input
                {...control}
                type="date"
                value={form.from}
                max={form.to}
                onChange={(event) => setField("from", event.target.value)}
              />
            )}
          </FormField>
          <FormField label="종료일">
            {(control) => (
              <Input
                {...control}
                type="date"
                value={form.to}
                min={form.from}
                onChange={(event) => setField("to", event.target.value)}
              />
            )}
          </FormField>
          <FormField label="상태">
            {(control) => (
              <Select
                {...control}
                value={form.status}
                onChange={(event) => setField("status", event.target.value)}
              >
                <option value="">전체</option>
                {workStatuses.map((status) => (
                  <option key={status} value={status}>
                    {statusLabels[status] ?? status}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          <FormField label="카테고리">
            {(control) => (
              <CategorySelect
                {...control}
                categories={categories}
                value={form.category}
                emptyLabel="전체"
                onChange={(id) => setField("category", id)}
              />
            )}
          </FormField>
          <FormField label="방식">
            {(control) => (
              <Select
                {...control}
                value={form.method}
                onChange={(event) => setField("method", event.target.value)}
              >
                <option value="">전체</option>
                {workMethods.map((method) => (
                  <option key={method} value={method}>
                    {methodLabels[method] ?? method}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
        {problem ? (
          <p className="field-error" role="alert">
            {problem}
          </p>
        ) : null}
        <div className="wc-form-actions">
          <Button disabled={problem !== undefined || preview.isPending} onClick={() => void runPreview()}>
            <Eye aria-hidden="true" /> {preview.isPending ? "계산 중" : "영향 미리보기"}
          </Button>
          <Button
            ref={runRef}
            variant="primary"
            disabled={runBlock !== undefined}
            title={runBlock}
            onClick={() => {
              if (current && Date.parse(current.expires_at) <= Date.now()) {
                setConflict("expired");
                setPreviewed(undefined);
                return;
              }
              setRunning(true);
            }}
          >
            <Play aria-hidden="true" /> 재분류 실행
          </Button>
        </div>
        {runBlock && canWrite ? <p className="wc-muted wc-note">{runBlock}</p> : null}

        {conflict ? (
          <InlineNotice
            tone="warning"
            title={
              conflict === "job_active" ? "재분류를 시작하지 않았습니다." : "미리보기를 다시 실행하세요."
            }
            actions={
              conflict === "job_active" ? undefined : (
                <Button
                  size="small"
                  disabled={problem !== undefined || preview.isPending}
                  onClick={() => {
                    setConflict(undefined);
                    void runPreview();
                  }}
                >
                  다시 미리보기
                </Button>
              )
            }
          >
            {reclassifyConflictMessages[conflict]}
          </InlineNotice>
        ) : null}

        {stale ? (
          <p className="wc-muted wc-note" role="status">
            조건이 바뀌어 이전 미리보기는 더 이상 맞지 않습니다. 영향 미리보기를 다시 실행하세요.
          </p>
        ) : null}
        {current ? (
          <PreviewResult
            preview={current}
            category={form.category ? categoryPath(categories, form.category).join(" › ") : ""}
            period={`${form.from} ~ ${form.to}`}
            activeJob={activeJob}
            onShowJob={showJob}
          />
        ) : null}
      </SectionCard>

      {jobId ? (
        <SectionCard
          headingLevel={3}
          title="재분류 작업"
          description="작업은 서버에서 계속 진행됩니다. 이 화면을 닫아도 멈추지 않으며, 주소를 그대로 열면 다시 볼 수 있습니다."
          actions={
            <Button size="small" variant="ghost" onClick={() => showJob("")}>
              <X aria-hidden="true" /> {jobRunning ? "숨기기" : "닫기"}
            </Button>
          }
        >
          {job.isError ? (
            <InlineNotice
              tone="danger"
              title="작업 상태를 불러오지 못했습니다."
              actions={<Button onClick={() => void job.refetch()}>다시 시도</Button>}
            >
              {classificationErrorMessage(job.error, "잠시 후 다시 시도하세요.")}
            </InlineNotice>
          ) : job.data ? (
            <JobProgress job={job.data} />
          ) : (
            <p className="wc-muted">작업 상태를 불러오는 중…</p>
          )}
        </SectionCard>
      ) : null}

      <RebuildSection
        key={`${form.from}:${form.to}`}
        from={form.from}
        to={form.to}
        writes={writes}
        canWrite={canWrite}
        lockTitle={lockTitle}
      />

      <ConfirmDialog
        open={running}
        onOpenChange={setRunning}
        returnFocusRef={runRef}
        title="재분류 실행"
        confirmLabel="재분류 시작"
        description={`${form.from} ~ ${form.to} 기간의 요청 ${formatNumber(current?.total ?? 0)}건을 배포된 정책으로 다시 분류합니다.`}
        requireReason
        errorFormatter={classificationErrorMessage}
        onConfirm={start}
      >
        <ul className="wc-plain-list">
          <li>수동 보정 {formatNumber(current?.manual_kept ?? 0)}건은 그대로 유지합니다.</li>
          {(current?.no_text_kept ?? 0) > 0 ? (
            <li>
              프롬프트 보존 기간이 지나 텍스트가 없는 요청 {formatNumber(current?.no_text_kept ?? 0)}건
              {current?.no_text_capped ? " 이상" : ""}은 기존 분류를 유지합니다.
            </li>
          ) : null}
          <li>예상 LLM 호출 {formatNumber(current?.est_llm_calls ?? 0)}회 (LLM 분류가 켜진 경우).</li>
          <li>
            집계 {formatNumber(current?.days ?? 0)}일치를 다시 만듭니다. 진행 중에는 통계가 잠시 달라 보일 수
            있습니다.
          </li>
        </ul>
      </ConfirmDialog>
    </>
  );
}

function Tally({
  title,
  values,
  labels,
}: {
  title: string;
  values: Readonly<Record<string, number>>;
  labels: Readonly<Record<string, string>>;
}): React.JSX.Element {
  const entries = Object.entries(values);
  return (
    <div className="wc-tally">
      <h4 className="wc-subheading">{title}</h4>
      {entries.length === 0 ? (
        <p className="wc-muted">해당 없음</p>
      ) : (
        <dl>
          {entries.map(([key, value]) => (
            <div key={key}>
              <dt>{labels[key] ?? key}</dt>
              <dd>{formatNumber(value)}건</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

function PreviewResult({
  preview,
  category,
  period,
  activeJob,
  onShowJob,
}: {
  preview: WorkReclassifyPreview;
  category: string;
  period: string;
  activeJob: WorkJob | null;
  onShowJob: (id: string) => void;
}): React.JSX.Element {
  return (
    <section className="wc-preview" aria-label="재분류 영향 미리보기">
      <h4 className="wc-subheading">영향 미리보기</h4>
      {activeJob ? (
        <InlineNotice
          tone="warning"
          title="진행 중인 재분류 작업이 있습니다."
          actions={
            <Button size="small" onClick={() => onShowJob(activeJob.id)}>
              진행 상황 보기
            </Button>
          }
        >
          한 번에 하나의 재분류만 실행할 수 있습니다. 진행 중인 작업이 끝난 뒤 다시 미리보기 하세요.
        </InlineNotice>
      ) : null}
      <KeyValueList
        columns={3}
        items={[
          { label: "대상 요청", value: `${formatNumber(preview.total)}건` },
          { label: "기간", value: `${period} (${formatNumber(preview.days)}일)` },
          { label: "카테고리", value: category || "전체" },
          { label: "유지되는 수동 보정", value: `${formatNumber(preview.manual_kept)}건` },
          ...(preview.no_text_kept > 0
            ? [
                {
                  label: "텍스트 없어 유지",
                  value: `${formatNumber(preview.no_text_kept)}건${preview.no_text_capped ? " 이상" : ""}`,
                },
              ]
            : []),
          { label: "예상 LLM 호출", value: `${formatNumber(preview.est_llm_calls)}회` },
          { label: "미리보기 만료", value: formatDateTime(preview.expires_at) },
        ]}
      />
      <div className="wc-tally-grid">
        <Tally title="상태별" values={preview.by_status} labels={statusLabels} />
        <Tally title="방식별" values={preview.by_method} labels={methodLabels} />
      </div>
      <p className="wc-muted wc-note">
        미리보기는 만료 시각까지만 유효하며, 만료되면 다시 미리보기 해야 합니다. 그 사이 대상 요청 수가
        바뀌어도 실행은 되고, 바뀐 건수는 작업 진행 상황에 표시됩니다.
      </p>
    </section>
  );
}

function JobProgress({ job }: { job: WorkJob }): React.JSX.Element {
  const { percent } = jobProgress(job);
  const finished = jobFinished(job.status);
  // The server runs a confirmed preview even when its count has moved since; 0 means it did not say.
  const { previewed, total } = job.progress;
  const drifted = previewed > 0 && previewed !== total;
  return (
    <div className="wc-job">
      <div className="wc-job-head">
        <Badge tone={jobStatusTones[job.status] ?? "muted"}>
          {jobStatusLabels[job.status] ?? job.status}
        </Badge>
        <code>{job.id}</code>
        <span className="wc-muted">
          {job.actor ? `${job.actor} · ` : ""}
          시작 {formatDateTime(job.created_at)}
        </span>
      </div>
      <div
        className="wc-progress"
        role="progressbar"
        aria-label="재분류 진행률"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% (${formatNumber(job.progress.done)} / ${formatNumber(job.progress.total)}건)`}
        data-status={job.status}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <p className="wc-job-summary" role="status">
        {percent}% · {formatNumber(job.progress.done)} / {formatNumber(job.progress.total)}건 처리
      </p>
      {drifted ? (
        <p className="wc-muted wc-note">
          미리보기 이후 대상이 {formatNumber(previewed)}건 → {formatNumber(total)}건으로 바뀌었습니다.
        </p>
      ) : null}
      <KeyValueList
        columns={3}
        items={[
          { label: "분류가 바뀐 요청", value: `${formatNumber(job.progress.changed)}건` },
          { label: "실패", value: `${formatNumber(job.progress.failed)}건` },
          ...(job.progress.kept_no_text > 0
            ? [{ label: "텍스트 없어 유지", value: `${formatNumber(job.progress.kept_no_text)}건` }]
            : []),
          {
            label: "다시 만든 집계",
            value: `${formatNumber(daysRebuiltCount(job.progress.days_rebuilt))}일`,
          },
          { label: "마지막 갱신", value: formatDateTime(job.updated_at) },
        ]}
      />
      {job.status === "succeeded" ? (
        <InlineNotice tone="success" title="재분류를 마쳤습니다.">
          {formatNumber(job.progress.changed)}건의 분류가 바뀌었고 해당 날짜의 집계를 다시 만들었습니다.
        </InlineNotice>
      ) : job.status === "failed" ? (
        <InlineNotice tone="danger" title="재분류가 실패했습니다.">
          처리한 {formatNumber(job.progress.done)}건까지는 반영됐습니다. 게이트웨이 로그를 확인한 뒤 다시
          미리보기 하고 실행하세요.
        </InlineNotice>
      ) : job.status === "interrupted" ? (
        <InlineNotice tone="warning" title="재분류가 중단되었습니다.">
          게이트웨이가 다시 시작되는 등의 이유로 작업이 끝나기 전에 멈췄습니다. 처리한{" "}
          {formatNumber(job.progress.done)}건까지는 반영됐습니다. 남은 요청은 다시 미리보기 하고 실행하세요.
        </InlineNotice>
      ) : null}
      {finished ? null : <p className="wc-muted wc-note">진행 상황을 2초마다 다시 확인합니다.</p>}
    </div>
  );
}

function RebuildSection({
  from: initialFrom,
  to: initialTo,
  writes,
  canWrite,
  lockTitle,
}: {
  from: string;
  to: string;
  writes: ReturnType<typeof useClassificationWrites>;
  canWrite: boolean;
  lockTitle: string | undefined;
}): React.JSX.Element {
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState<{ from: string; to: string; result: WorkRebuildResult } | undefined>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const problem = reclassifyFormProblem({ from, to, status: "", category: "", method: "" });
  const rebuiltDays = done ? daysRebuiltCount(done.result.days_rebuilt) : 0;
  return (
    <SectionCard
      headingLevel={3}
      title="집계 다시 만들기"
      description="분류 결과는 바꾸지 않고, 고른 기간의 일간 집계만 분류 결과에서 다시 계산합니다. 통계 숫자가 요청 목록과 맞지 않을 때 쓰는 복구 작업입니다."
    >
      <div className="wc-filter-grid">
        <FormField label="집계 시작일">
          {(control) => (
            <Input
              {...control}
              type="date"
              value={from}
              max={to}
              onChange={(event) => setFrom(event.target.value)}
            />
          )}
        </FormField>
        <FormField label="집계 종료일">
          {(control) => (
            <Input
              {...control}
              type="date"
              value={to}
              min={from}
              onChange={(event) => setTo(event.target.value)}
            />
          )}
        </FormField>
      </div>
      {problem ? (
        <p className="field-error" role="alert">
          {problem}
        </p>
      ) : null}
      <div className="wc-form-actions">
        <Button
          ref={triggerRef}
          disabled={!canWrite || problem !== undefined}
          title={lockTitle}
          onClick={() => setConfirming(true)}
        >
          <Hammer aria-hidden="true" /> 집계 다시 만들기
        </Button>
      </div>
      {done ? (
        <InlineNotice tone="success" title={`${done.from} ~ ${done.to} 집계를 다시 만들었습니다.`}>
          {rebuiltDays > 0
            ? `${formatNumber(rebuiltDays)}일치 집계를 다시 계산했습니다.`
            : "분류 결과는 바뀌지 않았습니다."}
        </InlineNotice>
      ) : null}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        returnFocusRef={triggerRef}
        title="집계 다시 만들기"
        confirmLabel="다시 만들기"
        description={`${from} ~ ${to} 기간의 집계를 지우고 분류 결과에서 다시 계산합니다. 분류 결과와 보정 이력은 바뀌지 않습니다.`}
        requireReason
        errorFormatter={classificationErrorMessage}
        onConfirm={async (reason) => {
          const result = await writes.rebuild.mutateAsync({ from, to, reason });
          setDone({ from, to, result });
        }}
      />
    </SectionCard>
  );
}
