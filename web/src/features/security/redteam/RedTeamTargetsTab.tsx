import { useQuery } from "@tanstack/react-query";
import { Download, Plus, Upload } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";

import { ProbeCaseDialog } from "@/features/security/redteam/ProbeCaseDialog";
import {
  newPackOption,
  probeCaseDefaults,
  type ProbeCaseFormValues,
} from "@/features/security/redteam/probe-case-form";
import { PanelFailure } from "@/features/security/redteam/RedTeamParts";
import { exportProbePrompts, importProbePrompts } from "@/features/security/redteam/redteam-csv";
import { riskTone, writeDeniedReason } from "@/features/security/redteam/redteam-ui";
import { redteamKeys, routeId, type RedTeamData } from "@/features/security/redteam/use-redteam-data";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { apiClient } from "@/shared/api/client";
import {
  withPathParams,
  type RedTeamProbeCase,
  type RedTeamProbePack,
  type RedTeamTarget,
} from "@/shared/api/domains/redteam";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { Input } from "@/shared/components/ui/Input";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { Toolbar } from "@/shared/components/ui/Toolbar";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { containsPotentialSecret, secretSearchMessage } from "@/shared/security/secrets";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const redteam = endpoints.domains.redteam;

function targetLabel(target: RedTeamTarget): string {
  const metadata = target.metadata;
  for (const key of ["title", "name", "base_url"]) {
    const value = metadata[key];
    if (typeof value === "string" && value !== "") return value;
  }
  return target.model || target.tool_name || target.target_ref;
}

function targetColumns(): ReadonlyArray<DataTableColumn<RedTeamTarget>> {
  const column = createDataTableColumnHelper<RedTeamTarget>();
  return column.columns([
    column.accessor((row) => row.target_type, {
      id: "target_type",
      header: "유형",
      cell: ({ getValue }) => <Badge tone="info">{getValue() || "—"}</Badge>,
    }),
    column.accessor((row) => row.target_ref, {
      id: "target_ref",
      header: "대상",
      cell: ({ row }) => (
        <div className="rt-stacked-cell">
          <code className="mono">{row.original.target_ref}</code>
          <span className="truncate">{targetLabel(row.original)}</span>
        </div>
      ),
    }),
    column.accessor((row) => row.risk_level, {
      id: "risk_level",
      header: "위험",
      cell: ({ getValue }) => <Badge tone={riskTone(getValue())}>{getValue() || "low"}</Badge>,
    }),
    column.accessor((row) => row.enabled, {
      id: "enabled",
      header: "상태",
      cell: ({ getValue }) => (
        <Badge tone={getValue() ? "success" : "warning"}>{getValue() ? "활성" : "비활성"}</Badge>
      ),
    }),
    column.accessor((row) => row.provider || row.mcp_upstream, {
      id: "provider",
      header: "프로바이더/업스트림",
      cell: ({ getValue }) => getValue() || "—",
    }),
  ]);
}

interface TargetsTabProps {
  canWrite: boolean;
  data: RedTeamData;
}

export function RedTeamTargetsTab({ canWrite, data }: TargetsTabProps): React.JSX.Element {
  const { probePacks, targets } = data;
  const packs = probePacks.data?.probe_packs ?? [];
  const [params, updateParams] = useSearchState();
  const requestedQuery = params.get("q") ?? "";
  const unsafeQuery = containsPotentialSecret(requestedQuery);
  const query = unsafeQuery ? "" : requestedQuery;
  const [searchError, setSearchError] = useState<string | undefined>(
    unsafeQuery ? secretSearchMessage : undefined,
  );

  const { remember, returnFocusRef } = useReturnFocus();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedTargetId, setSelectedTargetId] = useState("");
  const [openPack, setOpenPack] = useState<RedTeamProbePack | undefined>();
  const [caseDefaults, setCaseDefaults] = useState<ProbeCaseFormValues | undefined>();
  const [pendingCaseDelete, setPendingCaseDelete] = useState<RedTeamProbeCase | undefined>();

  const targetDetail = useQuery({
    queryKey: ["redteam", "targets", selectedTargetId] as const,
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(redteam.targets.detail, { id: selectedTargetId }), {
        signal,
        routeId,
      }),
    enabled: selectedTargetId !== "",
  });

  const saveCase = useMutationFeedback({
    mutate: (values: ProbeCaseFormValues) =>
      apiClient.request(redteam.probeCases.upsert, {
        body: {
          ...(values.case_id === "" ? {} : { case_id: values.case_id }),
          ...(values.pack === newPackOption
            ? { pack_name: values.pack_name || "사용자 정의 프롬프트" }
            : { pack_id: values.pack }),
          case_key: values.case_key,
          input_template: values.input_template,
          expected_policy: values.expected_policy,
          evaluator_type: values.evaluator_type,
          severity: values.severity,
          target_types: values.target_types
            .split(",")
            .map((item) => item.trim())
            .filter((item) => item !== ""),
        },
        routeId,
      }),
    invalidates: [redteamKeys.probePacks],
    successMessage: "프롬프트를 저장했습니다.",
    errorMessage: "프롬프트를 저장하지 못했습니다.",
    onSuccess: () => setOpenPack(undefined),
  });

  const deleteCase = useMutationFeedback({
    mutate: (probeCase: RedTeamProbeCase) =>
      apiClient.request(withPathParams(redteam.probeCases.remove, { id: probeCase.id }), { routeId }),
    invalidates: [redteamKeys.probePacks],
    successMessage: "프롬프트를 삭제했습니다.",
    errorMessage: "프롬프트를 삭제하지 못했습니다.",
    onSuccess: () => setOpenPack(undefined),
  });

  const exportCsv = useMutationFeedback({
    mutate: () => exportProbePrompts(),
    successMessage: "프롬프트 CSV를 내려받았습니다.",
    errorMessage: "프롬프트 CSV를 내보내지 못했습니다.",
  });

  const importCsv = useMutationFeedback({
    mutate: (csv: string) => importProbePrompts(csv),
    invalidates: [redteamKeys.probePacks],
    successMessage: (result) =>
      `프롬프트 ${formatNumber(result.imported_cases)}건, 팩 ${formatNumber(result.packs_touched)}건을 반영했습니다.`,
    errorMessage: "프롬프트 CSV를 가져오지 못했습니다.",
    onSuccess: (result) => {
      if (result.skipped.length > 0) {
        toast.warning(`건너뛴 행 ${formatNumber(result.skipped.length)}건`, {
          description: result.skipped.slice(0, 5).join(" · "),
        });
      }
    },
  });

  const allTargets = targets.data?.targets ?? [];
  const needle = query.trim().toLowerCase();
  const visibleTargets =
    needle === ""
      ? allTargets
      : allTargets.filter((target) =>
          [
            target.target_ref,
            target.target_type,
            target.provider,
            target.model,
            target.mcp_upstream,
            target.tool_name,
            target.owner_team,
          ]
            .join(" ")
            .toLowerCase()
            .includes(needle),
        );
  const selectedTarget =
    targetDetail.data?.target ?? allTargets.find((target) => target.id === selectedTargetId);
  const writeTitle = canWrite ? undefined : writeDeniedReason;

  return (
    <div className="rt-stack">
      <Toolbar label="프롬프트 관리">
        <Button
          disabled={!canWrite}
          title={writeTitle}
          onClick={(event) => {
            remember(event);
            setCaseDefaults(probeCaseDefaults(""));
          }}
        >
          <Plus aria-hidden="true" /> 프롬프트 추가
        </Button>
        <Button disabled={exportCsv.isPending} onClick={() => exportCsv.mutate(undefined)}>
          <Download aria-hidden="true" /> CSV 내보내기(엑셀)
        </Button>
        <Button
          disabled={!canWrite || importCsv.isPending}
          title={writeTitle}
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload aria-hidden="true" /> CSV 가져오기
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,text/csv"
          className="sr-only"
          aria-label="프롬프트 CSV 파일 선택"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            void file.text().then((text) => importCsv.mutate(text));
          }}
        />
      </Toolbar>
      <p className="rt-muted">
        레드팀이 보낼 요청 프롬프트를 직접 추가하거나 엑셀로 일괄 편집할 수 있습니다.
      </p>

      {targets.isError ? (
        <PanelFailure
          error={targets.error}
          hasData={Boolean(targets.data)}
          label="대상 인벤토리"
          onRetry={() => void targets.refetch()}
        />
      ) : null}

      <SectionCard
        title={`대상 인벤토리 (${formatNumber(allTargets.length)})`}
        description={targets.data?.note}
        actions={
          <form
            className="rt-search"
            role="search"
            onSubmit={(event) => {
              event.preventDefault();
              const value = new FormData(event.currentTarget).get("q");
              const next = typeof value === "string" ? value.trim() : "";
              if (containsPotentialSecret(next)) {
                setSearchError(secretSearchMessage);
                return;
              }
              setSearchError(undefined);
              updateParams({ q: next || undefined });
            }}
          >
            <label htmlFor="rt-target-search">대상 검색</label>
            <Input
              key={query}
              id="rt-target-search"
              name="q"
              defaultValue={query}
              placeholder="대상 참조, 프로바이더, 모델, 담당 팀"
              aria-invalid={searchError ? "true" : undefined}
              aria-describedby={searchError ? "rt-target-search-error" : undefined}
            />
            <Button size="small" type="submit">
              검색
            </Button>
            {searchError ? (
              <p id="rt-target-search-error" className="field-error" role="alert">
                {searchError}
              </p>
            ) : null}
          </form>
        }
      >
        <DataTable
          caption="레드팀이 대상으로 삼는 등록 자산 목록"
          columns={targetColumns()}
          data={visibleTargets}
          emptyMessage={
            allTargets.length === 0
              ? "등록된 대상이 없습니다. 프로바이더·MCP 업스트림·Text2SQL 프로필을 등록하면 자동 수집됩니다."
              : "검색 조건에 맞는 대상이 없습니다."
          }
          error={targets.isError && !targets.data ? "대상을 불러오지 못했습니다." : undefined}
          getRowActionLabel={(row) => `${row.target_ref} 상세 보기`}
          getRowId={(row) => row.id}
          loading={targets.isPending}
          onRetry={() => void targets.refetch()}
          onRowClick={(row) => setSelectedTargetId(row.id)}
        />
      </SectionCard>

      <SectionCard
        title={`프로브 팩 (${formatNumber(packs.length)})`}
        description="OWASP LLM Top10 기반 프로브와 사용자 정의 프롬프트입니다. 고위험 팩은 승인 없이는 실제 실행되지 않습니다."
      >
        {probePacks.isError && !probePacks.data ? (
          <PanelFailure
            error={probePacks.error}
            hasData={false}
            label="프로브 팩"
            onRetry={() => void probePacks.refetch()}
          />
        ) : packs.length === 0 ? (
          <EmptyState
            title="프로브 팩이 없습니다."
            description="프롬프트를 추가하거나 CSV를 가져오면 사용자 정의 팩이 만들어집니다."
          />
        ) : (
          <ul className="rt-pack-list">
            {packs.map((pack) => (
              <li key={pack.id}>
                <div className="rt-stacked-cell">
                  <span>
                    <strong>{pack.name}</strong> <Badge tone={riskTone(pack.severity)}>{pack.severity}</Badge>
                    {pack.requires_approval ? <Badge tone="warning">승인필요</Badge> : null}
                  </span>
                  <span>
                    {pack.category} · {pack.version} · 케이스 {formatNumber(pack.cases.length)}
                  </span>
                </div>
                <Button
                  size="small"
                  aria-label={`${pack.name} 케이스 보기`}
                  onClick={(event) => {
                    remember(event);
                    setOpenPack(pack);
                  }}
                >
                  케이스 보기
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <Sheet
        open={selectedTargetId !== ""}
        onOpenChange={(open) => {
          if (!open) setSelectedTargetId("");
        }}
        title="대상 상세"
        description="레드팀 대상으로 등록된 자산의 수집 정보입니다."
        returnFocusRef={returnFocusRef}
      >
        {selectedTarget ? (
          <div className="rt-stack">
            <KeyValueList
              columns={1}
              items={[
                { label: "대상 ID", value: selectedTarget.id, mono: true },
                { label: "유형", value: selectedTarget.target_type },
                { label: "대상 참조", value: selectedTarget.target_ref, mono: true },
                { label: "프로바이더", value: selectedTarget.provider },
                { label: "모델", value: selectedTarget.model },
                { label: "MCP 업스트림", value: selectedTarget.mcp_upstream },
                { label: "도구", value: selectedTarget.tool_name },
                { label: "담당 팀", value: selectedTarget.owner_team },
                {
                  label: "위험도",
                  value: (
                    <Badge tone={riskTone(selectedTarget.risk_level)}>
                      {selectedTarget.risk_level || "low"}
                    </Badge>
                  ),
                },
                {
                  label: "상태",
                  value: (
                    <Badge tone={selectedTarget.enabled ? "success" : "warning"}>
                      {selectedTarget.enabled ? "활성" : "비활성"}
                    </Badge>
                  ),
                },
                { label: "수집 시각", value: formatDateTime(selectedTarget.created_at) },
                { label: "갱신 시각", value: formatDateTime(selectedTarget.updated_at) },
              ]}
            />
            <JsonBlock label="수집 메타데이터" value={selectedTarget.metadata} />
          </div>
        ) : (
          <p role="status">대상 정보를 불러오는 중입니다.</p>
        )}
      </Sheet>

      <Sheet
        open={openPack !== undefined}
        onOpenChange={(open) => {
          if (!open) setOpenPack(undefined);
        }}
        title={openPack ? `${openPack.name} — 프롬프트(케이스)` : "프롬프트(케이스)"}
        description="각 케이스가 대상에 그대로 전송하는 요청 프롬프트와 기대 정책입니다."
        returnFocusRef={returnFocusRef}
        size="wide"
      >
        {openPack ? (
          <div className="rt-stack">
            <Button
              disabled={!canWrite}
              title={writeTitle}
              onClick={() => setCaseDefaults(probeCaseDefaults(openPack.id))}
            >
              <Plus aria-hidden="true" /> 이 팩에 프롬프트 추가
            </Button>
            <DataTable
              caption={`${openPack.name} 팩의 프롬프트 케이스`}
              columns={caseColumns({
                canWrite,
                onDelete: (probeCase) => setPendingCaseDelete(probeCase),
                onEdit: (probeCase) => setCaseDefaults(probeCaseDefaults(openPack.id, probeCase)),
              })}
              data={openPack.cases}
              emptyMessage="이 팩에는 케이스가 없습니다."
            />
          </div>
        ) : null}
      </Sheet>

      {caseDefaults ? (
        <ProbeCaseDialog
          defaults={caseDefaults}
          onOpenChange={(open) => {
            if (!open) setCaseDefaults(undefined);
          }}
          onSubmit={(values) => saveCase.mutateAsync(values)}
          open
          packs={packs}
          returnFocusRef={returnFocusRef}
        />
      ) : null}

      <ConfirmDialog
        open={pendingCaseDelete !== undefined}
        onOpenChange={(open) => {
          if (!open) setPendingCaseDelete(undefined);
        }}
        title="프롬프트 삭제"
        description={`케이스 "${pendingCaseDelete?.case_key ?? ""}"를 삭제합니다. 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        tone="danger"
        returnFocusRef={returnFocusRef}
        onConfirm={() => (pendingCaseDelete ? deleteCase.mutateAsync(pendingCaseDelete) : undefined)}
      />
    </div>
  );
}

function caseColumns({
  canWrite,
  onDelete,
  onEdit,
}: {
  canWrite: boolean;
  onDelete: (probeCase: RedTeamProbeCase) => void;
  onEdit: (probeCase: RedTeamProbeCase) => void;
}): ReadonlyArray<DataTableColumn<RedTeamProbeCase>> {
  const column = createDataTableColumnHelper<RedTeamProbeCase>();
  const writeTitle = canWrite ? undefined : writeDeniedReason;
  return column.columns([
    column.accessor((row) => row.case_key, {
      id: "case_key",
      header: "케이스",
      cell: ({ getValue }) => <code className="mono">{getValue()}</code>,
    }),
    column.accessor((row) => row.severity, {
      id: "severity",
      header: "심각도",
      cell: ({ getValue }) => <Badge tone={riskTone(getValue())}>{getValue() || "—"}</Badge>,
    }),
    column.accessor((row) => row.expected_policy, { id: "expected_policy", header: "기대 정책" }),
    column.accessor((row) => row.target_types.join(", "), {
      id: "target_types",
      header: "대상 유형",
      cell: ({ getValue }) => getValue() || "전체",
    }),
    column.accessor((row) => row.input_template, {
      id: "input_template",
      header: "요청 템플릿(시드)",
      cell: ({ getValue }) => <div className="rt-template">{getValue()}</div>,
    }),
    column.display({
      id: "actions",
      header: "작업",
      cell: ({ row }) => (
        <div className="table-actions">
          <Button
            size="small"
            disabled={!canWrite}
            title={writeTitle}
            aria-label={`${row.original.case_key} 편집`}
            onClick={() => onEdit(row.original)}
          >
            편집
          </Button>
          <Button
            size="small"
            variant="danger"
            disabled={!canWrite}
            title={writeTitle}
            aria-label={`${row.original.case_key} 삭제`}
            onClick={() => onDelete(row.original)}
          >
            삭제
          </Button>
        </div>
      ),
    }),
  ]);
}
