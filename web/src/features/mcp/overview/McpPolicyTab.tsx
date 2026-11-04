import { Plus } from "lucide-react";
import { useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";

import { QueryNotice } from "@/features/mcp/mcp-ui";
import { decisionLabel, decisionTone, riskLabel, riskTone } from "@/features/mcp/mcp-utils";
import type { McpPolicy } from "@/shared/api/domains/mcp.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

import { ErrorState, PermissionDenied } from "@/shared/components/state/PageStates";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { PolicyFormDialog, PolicyConfirmDialog } from "./PolicyReviewDialogs";
import { type PolicySnapshot, type PolicyCommand } from "./mcp-policy-review";
import { useMcpPolicyData } from "./use-mcp-policy-data";

type Review =
  { kind: "save"; before: PolicySnapshot; original?: McpPolicy } | Exclude<PolicyCommand, { kind: "save" }>;

const policyColumn = createDataTableColumnHelper<McpPolicy>();

interface LoopRow {
  session_id: string;
  server_label: string;
  tool_name: string;
  calls: number;
  errors: number;
  api_key_id: string;
  last_seen: string;
}
const loopColumn = createDataTableColumnHelper<LoopRow>();
const loopColumns = [
  loopColumn.accessor((row) => row.session_id, {
    id: "session",
    header: "세션",
    cell: (info) => <span className="mono truncate">{info.getValue<string>() || "—"}</span>,
  }),
  loopColumn.accessor((row) => `${row.server_label}/${row.tool_name}`, {
    id: "tool",
    header: "서버/도구",
    cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
  }),
  loopColumn.accessor((row) => formatNumber(row.calls), { id: "calls", header: "호출" }),
  loopColumn.accessor((row) => formatNumber(row.errors), { id: "errors", header: "오류" }),
  loopColumn.accessor((row) => row.api_key_id || "—", { id: "key", header: "API 키" }),
  loopColumn.accessor((row) => formatDateTime(row.last_seen), { id: "last", header: "최근" }),
] as ReadonlyArray<DataTableColumn<LoopRow>>;

export function McpPolicyTab({ canWrite }: { canWrite: boolean }): React.JSX.Element {
  const owner = useFeatureReadOwner(
    "mcp.overview",
    "mcp-policy",
    ["observability:read"],
    "observability:read",
  );
  if (!owner.readable) return <PermissionDenied permission="observability:read" />;
  if (owner.denied)
    return (
      <ErrorState
        title="MCP 정책 조회 권한을 다시 확인하세요."
        message="이전 정책과 입력 내용을 표시하지 않습니다."
        onRetry={owner.restart}
        showLegacy={false}
      />
    );
  return <McpPolicyContent key={owner.id} owner={owner} canWrite={canWrite} />;
}
function McpPolicyContent({ owner, canWrite }: { owner: FeatureReadOwner; canWrite: boolean }) {
  const auth = useAuth();
  const write = useFeatureMutationAccess(
    ["mcp.overview"],
    canWrite && auth.user?.scopes.includes("mcp:admin") === true,
    "MCP 관리 권한(mcp:admin)이 필요합니다.",
  );
  const [review, setReview] = useState<Review>();
  const { returnFocusRef, remember } = useReturnFocus();
  const [lookup, setLookup] = useState({ server: "", tool: "" });
  const [submitted, setSubmitted] = useState<typeof lookup>();
  const [lookupError, setLookupError] = useState<string>();
  const { policies, loops, effective } = useMcpPolicyData(owner, submitted);
  const editable = write.allowed && policies.isSuccess && !policies.isFetching;
  const lookupChanged =
    submitted && (lookup.server.trim() !== submitted.server || lookup.tool.trim() !== submitted.tool);
  const showReview = (value: Review, event: { currentTarget: HTMLElement }) => {
    if (!editable) return;
    remember(event);
    setReview(value);
  };

  const policyColumns = [
    policyColumn.accessor((row) => row.server_label, {
      id: "server",
      header: "서버 라벨",
      cell: (info) => <span className="mono">{info.getValue<string>()}</span>,
    }),
    policyColumn.accessor((row) => row.mode, {
      id: "mode",
      header: "모드",
      cell: (info) => (
        <Badge tone={decisionTone(info.getValue<string>())}>{decisionLabel(info.getValue<string>())}</Badge>
      ),
    }),
    policyColumn.accessor((row) => row.note || "—", { id: "note", header: "메모" }),
    policyColumn.accessor((row) => formatDateTime(row.updated_at), { id: "updated", header: "수정" }),
    policyColumn.display({
      id: "actions",
      header: "작업",
      cell: (info) => (
        <div className="mcp-row-actions">
          <Button
            size="small"
            disabled={!editable}
            aria-label={info.row.original.server_label + " 정책 편집"}
            onClick={(event) => {
              if (policies.data)
                showReview({ kind: "save", before: policies.data, original: info.row.original }, event);
            }}
          >
            편집
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={!editable}
            aria-label={info.row.original.server_label + " 정책 삭제"}
            onClick={(event) => {
              if (policies.data)
                showReview({ kind: "delete", before: policies.data, original: info.row.original }, event);
            }}
          >
            삭제
          </Button>
        </div>
      ),
    }),
  ] as ReadonlyArray<DataTableColumn<McpPolicy>>;

  const effectivePolicy = effective.data?.policy;
  const effectiveFinal = effective.data?.final;

  return (
    <div className="mcp-section-stack">
      {policies.isError ? (
        <QueryNotice
          error={policies.error}
          hasData={Boolean(policies.data)}
          label="MCP 정책"
          onRetry={() => void policies.refetch()}
        />
      ) : null}

      <SectionCard
        title="서버 정책"
        description="서버 라벨 단위로 MCP 도구 호출을 허용·경고·차단합니다."
        actions={
          <Toolbar
            label="정책 작업"
            end={
              <Button
                variant="primary"
                disabled={!editable}
                title={write.reason}
                onClick={(event) => {
                  if (policies.data) showReview({ kind: "save", before: policies.data }, event);
                }}
              >
                <Plus aria-hidden="true" /> 정책 추가
              </Button>
            }
          >
            <span>
              허용목록: {policies.data ? (policies.data.allowlist_enabled ? "사용" : "미사용") : "확인 중"}
            </span>
            <Button
              disabled={!editable}
              title={write.reason}
              onClick={(event) => {
                if (policies.data)
                  showReview(
                    { kind: "allowlist", before: policies.data, enabled: !policies.data.allowlist_enabled },
                    event,
                  );
              }}
            >
              허용목록 변경 검토
            </Button>
          </Toolbar>
        }
      >
        {policies.isSuccess && policies.data.policies.length === 0 ? (
          <EmptyState
            title="등록된 서버 정책이 없습니다."
            description="정책을 추가하면 해당 서버의 도구 호출을 차단하거나 경고로 표시할 수 있습니다."
          />
        ) : (
          <DataTable
            caption="MCP 서버 정책"
            columns={policyColumns}
            data={policies.data?.policies ?? []}
            loading={policies.isPending}
            error={policies.isError && !policies.data ? "서버 정책을 불러오지 못했습니다." : undefined}
            getRowId={(row) => row.server_label}
          />
        )}
      </SectionCard>

      <SectionCard
        title="실효 정책 조회"
        description="서버와 도구를 입력하면 최종 판단(허용·경고·승인·차단)과 근거를 보여 줍니다."
      >
        <form
          className="mcp-inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const value = { server: lookup.server.trim(), tool: lookup.tool.trim() };
            if (!value.server || effective.isFetching) return;
            if (
              containsPotentialSecret(value.server, auth.credentialPrefixes) ||
              containsPotentialSecret(value.tool, auth.credentialPrefixes)
            ) {
              setLookupError(secretSearchMessage);
              return;
            }
            setLookupError(undefined);
            if (submitted?.server === value.server && submitted.tool === value.tool) void effective.refetch();
            else setSubmitted(value);
          }}
        >
          <label htmlFor="mcp-eff-server">
            서버 라벨
            <Input
              id="mcp-eff-server"
              value={lookup.server}
              required
              onChange={(event) => setLookup((prev) => ({ ...prev, server: event.target.value }))}
            />
          </label>
          <label htmlFor="mcp-eff-tool">
            도구 이름 (선택)
            <Input
              id="mcp-eff-tool"
              value={lookup.tool}
              onChange={(event) => setLookup((prev) => ({ ...prev, tool: event.target.value }))}
            />
          </label>
          <Button type="submit" variant="primary" disabled={effective.isFetching}>
            {effective.isFetching ? "조회 중" : "조회"}
          </Button>
        </form>
        {lookupError ? (
          <p className="form-error" role="alert">
            {lookupError}
          </p>
        ) : null}
        {submitted ? (
          <p>
            조회 기준: {submitted.server} / {submitted.tool || "서버 전체"}
            {lookupChanged ? " · 입력한 변경은 아직 조회하지 않았습니다." : ""}
          </p>
        ) : null}
        {effective.isError ? (
          <QueryNotice
            error={effective.error}
            hasData={Boolean(effective.data)}
            label="실효 정책"
            onRetry={() => void effective.refetch()}
          />
        ) : null}
        {effective.data ? (
          <KeyValueList
            items={[
              { label: "서버", value: effective.data.server, mono: true },
              { label: "도구", value: effective.data.tool || "(서버 전체)", mono: true },
              { label: "서버 정책", value: decisionLabel(effectivePolicy?.server_policy ?? "") },
              { label: "허용목록", value: effectivePolicy?.allowlist_enabled ? "사용" : "미사용" },
              {
                label: "도구 위험도",
                value: effectivePolicy?.tool_risk_level ? (
                  <Badge tone={riskTone(effectivePolicy.tool_risk_level)}>
                    {riskLabel(effectivePolicy.tool_risk_level)}
                  </Badge>
                ) : (
                  "—"
                ),
              },
              { label: "도구 조치", value: decisionLabel(effectivePolicy?.tool_risk_action ?? "") },
              {
                label: "최종 판단",
                value: effectiveFinal ? (
                  <Badge tone={decisionTone(effectiveFinal.decision)}>
                    {decisionLabel(effectiveFinal.decision)}
                  </Badge>
                ) : (
                  "—"
                ),
              },
              { label: "근거", value: effectiveFinal?.reason || "—" },
            ]}
          />
        ) : null}
      </SectionCard>

      <SectionCard
        title="에이전트 루프 의심"
        description="최근 24시간 동안 한 세션에서 같은 도구를 10회 이상 호출한 사례를 최대 50개 조회합니다."
      >
        {loops.isError ? (
          <QueryNotice
            error={loops.error}
            hasData={Boolean(loops.data)}
            label="에이전트 루프"
            onRetry={() => void loops.refetch()}
          />
        ) : null}
        <DataTable
          caption="에이전트 루프 의심 세션"
          columns={loopColumns}
          data={loops.data?.loops ?? []}
          loading={loops.isPending}
          error={loops.isError && !loops.data ? "에이전트 루프를 불러오지 못했습니다." : undefined}
          getRowId={(row, index) => `${row.session_id}:${row.tool_name}:${index}`}
          emptyMessage="루프로 의심되는 호출이 없습니다."
        />
      </SectionCard>

      {review?.kind === "save" ? (
        <PolicyFormDialog
          before={review.before}
          original={review.original}
          owner={owner}
          canWrite={canWrite}
          returnFocusRef={returnFocusRef}
          onClose={() => setReview(undefined)}
        />
      ) : null}
      {review && review.kind !== "save" ? (
        <PolicyConfirmDialog
          command={review}
          owner={owner}
          canWrite={canWrite}
          returnFocusRef={returnFocusRef}
          onClose={() => setReview(undefined)}
        />
      ) : null}
    </div>
  );
}
