import { useEffect, useRef, useState } from "react";
import { Plus, RefreshCw } from "lucide-react";
import { useAuth } from "@/app/auth/AuthProvider";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { TabPanel, Tabs } from "@/shared/components/ui/Tabs";
import { pageFromParam, useSearchState } from "@/shared/hooks/use-search-state";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { sanitizeAppRouteSearch } from "@/shared/security/app-route-query";
import { formatDuration, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";
import { RegressionBoundary } from "./RegressionBoundary";
import { RegressionDetail } from "./RegressionDetail";
import { RegressionQueryState } from "./RegressionQueryState";
import { RegressionTable, type RegressionRow } from "./RegressionTable";
import {
  canLinkRegressionID,
  regressionTabItems,
  regressionTabs,
  resultSummary,
  type RegressionTab,
} from "./regression-model";
import { useGoldenPrompts, useGoldenWorkflows } from "./use-regression";
import { DefinitionDialog } from "./editor/DefinitionDialog";
import { newDefinitionTarget, type DefinitionTarget } from "./editor/definition-form";
import { useDefinitionAccess } from "./editor/use-definition-write";
import "./regression.css";

export function RegressionPage() {
  return <RegressionBoundary>{(owner) => <RegressionContent owner={owner} />}</RegressionBoundary>;
}

function RegressionContent({ owner }: { owner: FeatureReadOwner }) {
  const { credentialPrefixes } = useAuth();
  const access = useDefinitionAccess();
  const [editing, setEditing] = useState<DefinitionTarget>();
  const [params, update] = useSearchState();
  const tab: RegressionTab = regressionTabs.find((value) => value === params.get("tab")) ?? "prompts";
  const rawLimit = Number(params.get("limit"));
  const limit = [50, 100, 200].includes(rawLimit) ? rawLimit : 50;
  const outcome = ["passed", "failed"].includes(params.get("outcome") ?? "") ? params.get("outcome") : "all";
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [localSelection, setLocalSelection] = useState<string>();
  const selected = localSelection ?? params.get("selection") ?? undefined;
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const listHeading = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim().toLocaleLowerCase()), 200);
    return () => window.clearTimeout(timer);
  }, [search]);
  const prompts = useGoldenPrompts(
    owner,
    limit,
    undefined,
    true,
    tab !== "workflows" && !selected && !editing,
  );
  const workflows = useGoldenWorkflows(owner, tab === "workflows" && !editing);
  const active = tab === "workflows" ? workflows : prompts;
  const promptRows = prompts.data?.golden_prompts ?? [];
  const workflowRows = workflows.data?.workflows ?? [];
  const results = prompts.data?.results ?? [];
  const summary = resultSummary(results);
  const names = new Map(promptRows.map((row) => [row.id, row.name || "이름 없음"]));
  const allRows: RegressionRow[] =
    tab === "prompts"
      ? promptRows.map((row) => ({
          id: row.id,
          name: row.name,
          tags: row.tags ?? [],
          time: row.updated_at,
        }))
      : tab === "workflows"
        ? workflowRows.map((row) => ({
            id: row.id,
            name: row.name,
            tags: row.tags ?? [],
            time: row.updated_at,
            steps: row.steps?.length ?? null,
          }))
        : results
            .filter((row) => outcome === "all" || (outcome === "passed" ? row.passed : !row.passed))
            .map((row) => ({
              id: row.id,
              name: names.get(row.prompt_id) ?? "현재 등록 정보 없음",
              tags: [],
              time: row.created_at,
              result: row,
            }));
  const rows = allRows.filter(
    (row) =>
      !debounced ||
      [row.name, ...row.tags, row.result?.model ?? ""].some((value) =>
        value.toLocaleLowerCase().includes(debounced),
      ),
  );
  const href = (id: string) => {
    if (!canLinkRegressionID(id, credentialPrefixes)) return undefined;
    const next = new URLSearchParams(params);
    next.set("selection", id);
    const safe = sanitizeAppRouteSearch("/prompts/regression", next.toString(), credentialPrefixes);
    return `/prompts/regression${safe.search}`;
  };
  const open = (id: string) => {
    if (canLinkRegressionID(id, credentialPrefixes)) update({ selection: id }, { replace: false });
    else setLocalSelection(id);
  };
  const refresh = () => void active.refetch();
  return (
    <div className="page-stack">
      <PageHeader
        title="회귀 검증 세트"
        status={access.allowed ? "preview" : "preview_read_only"}
        readOnly={!access.allowed}
        description="모델 변경을 점검할 기준 프롬프트와 독립적인 검증 단계를 관리합니다."
        actions={
          <>
            {access.allowed && tab !== "results" ? (
              <Button
                variant="primary"
                onClick={(event) => {
                  returnFocusRef.current = event.currentTarget;
                  setEditing(newDefinitionTarget(tab === "prompts" ? "prompt" : "workflow"));
                }}
              >
                <Plus aria-hidden="true" />
                {tab === "prompts" ? "기준 프롬프트 추가" : "검증 워크플로 추가"}
              </Button>
            ) : null}
            <Button
              variant={access.allowed && tab !== "results" ? "secondary" : "primary"}
              disabled={active.isFetching}
              onClick={refresh}
            >
              <RefreshCw aria-hidden="true" /> 새로고침
            </Button>
          </>
        }
      />
      <StatGrid label="회귀 검증 조회 요약">
        <StatCard
          label="기준 프롬프트"
          value={formatNumber(prompts.data?.golden_prompts.length)}
          hint={prompts.isError ? "갱신 실패" : "등록된 정의"}
        />
        <StatCard
          label="검증 워크플로"
          value={formatNumber(workflows.data?.workflows.length)}
          hint={workflows.isError ? "갱신 실패" : "순서가 있는 독립 검사 세트"}
        />
        <StatCard
          label="최근 저장 결과"
          value={formatNumber(prompts.data ? summary.count : undefined)}
          hint={`전체 중 최근 최대 ${limit}건`}
        />
        <StatCard
          label="조회 결과 통과율"
          value={formatPercent(prompts.data ? summary.passRate : undefined)}
          hint="수신한 결과만 집계 · 전체 품질 아님"
        />
      </StatGrid>
      <details>
        <summary>조회 범위와 검사 방식 안내</summary>
        <p>
          편집 권한이 있으면 정의를 등록·수정할 수 있습니다. 모델 실행은 기존 운영 API와 회귀 검증 스크립트를
          사용하며, 같은 기능의 기존 관리자 화면은 없습니다.
        </p>
        <p>
          목록의 정의는 전체 수신 후 25개씩 표시합니다. 결과는 최신순 최대 200건이며 전체 실행 수나 과거 정의
          버전은 제공되지 않습니다. 워크플로의 단계는 서로 출력을 전달하지 않습니다.
        </p>
        <p>
          비밀값으로 의심되는 내용과 표시 한도를 넘는 내용은 숨깁니다. 이름 없는 비밀값이나 자연어
          개인정보까지 탐지하는 보장은 아닙니다. 검색어는 이 화면 메모리에만 남고 주소·저장소로 전송하지
          않습니다.
        </p>
      </details>
      <Tabs
        items={regressionTabItems}
        value={tab}
        ariaLabel="회귀 검증 화면"
        panelIdPrefix="regression"
        onChange={(next) => {
          setSearch("");
          setDebounced("");
          setLocalSelection(undefined);
          update({ tab: next, page: undefined, selection: undefined }, { replace: false });
        }}
      />
      <TabPanel key={tab} id={tab} panelIdPrefix="regression">
        <SectionCard
          title={regressionTabItems.find((item) => item.id === tab)?.label}
          description={
            tab === "results"
              ? `최근 ${limit}건 안에서 검색·결과 필터를 적용합니다.`
              : "이름과 태그를 검색하고 상세 패널에서 내용을 확인하세요."
          }
        >
          <div className="page-stack" ref={listHeading} tabIndex={-1}>
            <div className="regression-filters">
              <label className="regression-search">
                {tab === "results" ? "프롬프트 이름·모델 검색" : "이름·태그 검색"}
                <Input
                  value={search}
                  maxLength={500}
                  onChange={(event) => {
                    setSearch(event.target.value);
                    if (params.has("page")) update({ page: undefined });
                  }}
                  placeholder="수신한 목록에서 검색"
                />
              </label>
              {tab === "results" ? (
                <>
                  <label>
                    최근 결과 범위
                    <Select
                      aria-label="최근 결과 범위"
                      value={limit}
                      onChange={(event) =>
                        update({ limit: event.target.value, page: undefined, selection: undefined })
                      }
                    >
                      {[50, 100, 200].map((value) => (
                        <option key={value} value={value}>
                          최근 {value}건
                        </option>
                      ))}
                    </Select>
                  </label>
                  <label>
                    검사 결과
                    <Select
                      aria-label="검사 결과"
                      value={outcome ?? "all"}
                      onChange={(event) =>
                        update({
                          outcome: event.target.value === "all" ? undefined : event.target.value,
                          page: undefined,
                        })
                      }
                    >
                      <option value="all">전체 결과</option>
                      <option value="passed">통과</option>
                      <option value="failed">미통과</option>
                    </Select>
                  </label>
                </>
              ) : null}
              <Button
                onClick={() => {
                  setSearch("");
                  setDebounced("");
                  update({ outcome: undefined, page: undefined });
                }}
              >
                검색·필터 초기화
              </Button>
            </div>
            <RegressionQueryState
              error={active.error}
              updatedAt={active.dataUpdatedAt}
              fetching={active.isFetching}
              retry={refresh}
            />
            {tab === "results" && prompts.data ? (
              <InlineNotice
                title={`수신 결과 ${results.length}건 · 통과 ${results.filter((row) => row.passed).length}건`}
              >
                수신 결과 비용 {formatKRW(summary.cost)}, 평균 지연 {formatDuration(summary.latency)}입니다.
                검색·통과 필터는 아래 목록에만 적용합니다. 실행 시점의 기준은 저장되지 않으며, 현재 기준과
                같다고 볼 수 없습니다.
              </InlineNotice>
            ) : null}
            <RegressionTable
              rows={rows}
              tab={tab}
              page={pageFromParam(params.get("page"))}
              setPage={(page) => update({ page })}
              loading={active.isPending}
              failed={active.isError && !active.data}
              retry={refresh}
              open={open}
              href={href}
              captureFocus={(element) => {
                returnFocusRef.current = element;
              }}
            />
            {!active.isPending && !active.isError && allRows.length === 0 ? (
              <p className="muted">
                아직 등록된 항목이나 저장된 실행 결과가 없습니다. 세트를 등록하고 기존 실행 도구로 검사하면
                결과를 조회할 수 있습니다.
              </p>
            ) : null}
          </div>
        </SectionCard>
      </TabPanel>
      {selected ? (
        <RegressionDetail
          key={`${tab}:${selected}`}
          owner={owner}
          tab={tab}
          id={selected}
          workflows={workflowRows}
          results={results}
          loading={active.isFetching}
          error={active.error}
          updatedAt={active.dataUpdatedAt}
          retry={refresh}
          returnFocusRef={returnFocusRef}
          edit={
            access.allowed
              ? (target) => {
                  returnFocusRef.current = listHeading.current;
                  setLocalSelection(undefined);
                  update({ selection: undefined }, { replace: true });
                  setEditing(target);
                }
              : undefined
          }
          close={() => {
            if (!returnFocusRef.current?.isConnected) returnFocusRef.current = listHeading.current;
            setLocalSelection(undefined);
            update({ selection: undefined }, { replace: false });
          }}
        />
      ) : null}
      {editing ? (
        <DefinitionDialog
          key={`${editing.kind}:${editing.id}`}
          owner={owner}
          target={editing}
          returnFocusRef={returnFocusRef}
          close={() => setEditing(undefined)}
        />
      ) : null}
    </div>
  );
}
