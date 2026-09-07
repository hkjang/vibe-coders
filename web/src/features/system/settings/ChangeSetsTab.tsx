import { Plus } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { z } from "zod";

import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import { routeId, systemSettingsKeys, useChangeSets } from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import type { ChangeSet } from "@/shared/api/domains/system.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

const system = endpoints.domains.system;

const statusTones: Record<string, "danger" | "info" | "muted" | "success" | "warning"> = {
  draft: "muted",
  pending: "warning",
  approved: "info",
  apply_pending: "warning",
  applied: "success",
  rollback_pending: "warning",
  rolled_back: "muted",
};

const changeSetItemsSchema = z.array(
  z.object({
    kind: z.string().min(1),
    key: z.string().min(1),
    value: z.string(),
    note: z.string().optional(),
  }),
);

const createSchema = z.object({
  title: z.string().trim().min(1, "제목을 입력하세요."),
  description: z.string().trim(),
  canary_scope: z.string().trim(),
  items: z
    .string()
    .trim()
    .refine((raw) => {
      if (raw === "") return true;
      try {
        return changeSetItemsSchema.safeParse(JSON.parse(raw)).success;
      } catch {
        return false;
      }
    }, "items는 {kind, key, value} 객체의 JSON 배열이어야 합니다."),
});

type CreateValues = z.output<typeof createSchema>;

const simulateSchema = z.object({
  change_type: z.enum(["block_model", "model_price", "route_remap"]),
  days: z
    .string()
    .trim()
    .refine((raw) => {
      const parsed = Number(raw);
      return Number.isInteger(parsed) && parsed >= 1 && parsed <= 90;
    }, "1~90 사이의 일수를 입력하세요."),
  pattern: z.string().trim(),
  model: z.string().trim(),
  input_krw_per_1m: z.string().trim(),
  output_krw_per_1m: z.string().trim(),
  from: z.string().trim(),
  to: z.string().trim(),
});

type SimulateValues = z.output<typeof simulateSchema>;

function simulateParams(values: SimulateValues): Record<string, string | number> {
  if (values.change_type === "block_model") return { pattern: values.pattern };
  if (values.change_type === "model_price") {
    return {
      model: values.model,
      input_krw_per_1m: Number(values.input_krw_per_1m) || 0,
      output_krw_per_1m: Number(values.output_krw_per_1m) || 0,
    };
  }
  return { from: values.from, to: values.to };
}

export function ChangeSetsTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
  const changeSets = useChangeSets();
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const rowTriggerRef = useRef<HTMLElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>();

  const rows = useMemo(() => changeSets.data?.change_sets ?? [], [changeSets.data?.change_sets]);
  const selected = rows.find((row) => row.id === selectedId);

  const createForm = useZodForm<CreateValues, CreateValues>(createSchema, {
    title: "",
    description: "",
    canary_scope: "",
    items: "",
  });

  const simulateForm = useZodForm<SimulateValues, SimulateValues>(simulateSchema, {
    change_type: "block_model",
    days: "7",
    pattern: "",
    model: "",
    input_krw_per_1m: "",
    output_krw_per_1m: "",
    from: "",
    to: "",
  });
  const changeType = simulateForm.watch("change_type");

  const createChangeSet = useMutationFeedback({
    mutate: async (values: CreateValues) => {
      const items =
        values.items === ""
          ? []
          : changeSetItemsSchema.parse(JSON.parse(values.items) as unknown).map((item) => ({
              kind: item.kind,
              key: item.key,
              value: item.value,
              ...(item.note ? { note: item.note } : {}),
            }));
      return apiClient.request(system.changeSets.create, {
        body: {
          title: values.title,
          description: values.description,
          canary_scope: values.canary_scope,
          items,
        },
        routeId,
      });
    },
    invalidates: [systemSettingsKeys.changeSets],
    successMessage: "변경 세트를 만들었습니다.",
    errorMessage: "변경 세트를 만들지 못했습니다.",
  });

  const simulate = useMutationFeedback({
    mutate: async (values: SimulateValues) =>
      apiClient.request(system.changeSets.simulateImpact, {
        body: {
          change_type: values.change_type,
          days: Number(values.days),
          params: simulateParams(values),
        },
        routeId,
      }),
    errorMessage: "변경 영향도를 계산하지 못했습니다.",
  });

  const counts = {
    total: rows.length,
    pending: rows.filter((row) => row.status === "pending").length,
    approved: rows.filter((row) => row.status === "approved").length,
    applied: rows.filter((row) => row.status === "applied").length,
  };

  return (
    <div className="settings-tab-stack">
      <StatGrid label="변경 세트 요약">
        <StatCard label="전체" value={formatNumber(counts.total)} />
        <StatCard label="검토 대기" value={formatNumber(counts.pending)} tone="warning" />
        <StatCard label="승인됨" value={formatNumber(counts.approved)} tone="info" />
        <StatCard label="적용됨" value={formatNumber(counts.applied)} tone="success" />
      </StatGrid>

      <InlineNotice tone="info" title="제출·승인·적용·롤백은 아직 기존 화면에서 진행합니다.">
        이 작업들의 API 경로가 게이트웨이 OpenAPI 문서에 없어 신규 콘솔에서 호출할 수 없습니다. 목록·생성·
        상세 확인과 영향도 시뮬레이션은 이 화면에서 처리하고, 승인 절차는{" "}
        <a href="/admin#/changesets">기존 화면에서 열기</a>로 이어서 진행하세요.
      </InlineNotice>

      {changeSets.isError ? (
        <QueryNotice
          error={changeSets.error}
          hasPreviousData={Boolean(changeSets.data)}
          label="변경 세트 목록"
          onRetry={() => void changeSets.refetch()}
        />
      ) : null}

      <SectionCard
        title="변경 세트"
        headingLevel={3}
        description="여러 설정 변경을 하나의 승인 단위로 묶습니다."
        actions={
          <Button
            ref={createTriggerRef}
            size="small"
            variant="primary"
            disabled={!hasAdminWrite}
            onClick={() => setCreating(true)}
          >
            <Plus aria-hidden="true" /> 새 변경 세트
          </Button>
        }
      >
        {!changeSets.isPending && rows.length === 0 ? (
          <EmptyState
            title="아직 변경 세트가 없습니다."
            description="설정 변경을 묶어 승인 절차를 거치려면 새 변경 세트를 만드세요."
          />
        ) : (
          <table className="data-table">
            <caption className="sr-only">변경 세트 목록</caption>
            <thead>
              <tr>
                <th scope="col">제목</th>
                <th scope="col">상태</th>
                <th scope="col">항목 수</th>
                <th scope="col">생성자</th>
                <th scope="col">생성</th>
                <th scope="col">적용</th>
                <th scope="col">작업</th>
              </tr>
            </thead>
            <tbody>
              {changeSets.isPending ? (
                <tr>
                  <td colSpan={7} className="data-table-state">
                    <span role="status">변경 세트를 불러오는 중입니다.</span>
                  </td>
                </tr>
              ) : (
                rows.map((row: ChangeSet) => (
                  <tr key={row.id}>
                    <th scope="row">{row.title || row.id}</th>
                    <td>
                      <Badge tone={statusTones[row.status ?? ""] ?? "muted"}>{row.status ?? "—"}</Badge>
                    </td>
                    <td className="cell-number">{formatNumber(row.items?.length ?? 0)}</td>
                    <td>{row.created_by || "—"}</td>
                    <td>{formatDateTime(row.created_at)}</td>
                    <td>{formatDateTime(row.applied_at)}</td>
                    <td>
                      <Button
                        size="small"
                        variant="ghost"
                        aria-label={`${row.title || row.id} 상세`}
                        onClick={(event) => {
                          rowTriggerRef.current = event.currentTarget;
                          setSelectedId(row.id);
                        }}
                      >
                        상세
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
        <UpdatedAt at={changeSets.dataUpdatedAt} />
      </SectionCard>

      <SectionCard
        title="변경 영향도 시뮬레이터"
        headingLevel={3}
        description="최근 사용 기록에 제안한 변경을 대입해 영향 범위를 추정합니다. 실제로 적용되지 않습니다."
      >
        <form
          className="form-grid"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void simulateForm.handleSubmit((values) => {
              simulate.mutate(values);
            })(event);
          }}
        >
          <FormField label="변경 유형">
            {(control) => (
              <Select
                {...control}
                {...simulateForm.register("change_type")}
                options={[
                  { value: "block_model", label: "모델 차단 (block_model)" },
                  { value: "model_price", label: "모델 단가 변경 (model_price)" },
                  { value: "route_remap", label: "모델 재라우팅 (route_remap)" },
                ]}
              />
            )}
          </FormField>
          <FormField label="분석 기간(일)" error={simulateForm.formState.errors.days?.message}>
            {(control) => (
              <Input {...control} type="number" min={1} max={90} {...simulateForm.register("days")} />
            )}
          </FormField>

          {changeType === "block_model" ? (
            <FormField label="모델 패턴" description="쉼표로 구분한 glob 패턴 (예: gpt-4*,claude-*)">
              {(control) => <Input {...control} {...simulateForm.register("pattern")} />}
            </FormField>
          ) : null}

          {changeType === "model_price" ? (
            <>
              <FormField label="모델">
                {(control) => <Input {...control} {...simulateForm.register("model")} />}
              </FormField>
              <FormField label="새 입력 단가(1M 토큰, 원)">
                {(control) => (
                  <Input {...control} type="number" {...simulateForm.register("input_krw_per_1m")} />
                )}
              </FormField>
              <FormField label="새 출력 단가(1M 토큰, 원)">
                {(control) => (
                  <Input {...control} type="number" {...simulateForm.register("output_krw_per_1m")} />
                )}
              </FormField>
            </>
          ) : null}

          {changeType === "route_remap" ? (
            <>
              <FormField label="원본 모델">
                {(control) => <Input {...control} {...simulateForm.register("from")} />}
              </FormField>
              <FormField label="대상 모델">
                {(control) => <Input {...control} {...simulateForm.register("to")} />}
              </FormField>
            </>
          ) : null}

          <div className="settings-form-actions">
            <Button type="submit" variant="primary" disabled={simulate.isPending}>
              {simulate.isPending ? "계산 중" : "영향도 계산"}
            </Button>
          </div>
        </form>
        {simulate.data ? <JsonBlock label="영향도 결과" value={simulate.data} /> : null}
      </SectionCard>

      <FormDialog
        open={creating}
        onOpenChange={(next) => {
          setCreating(next);
          if (!next) createForm.reset();
        }}
        form={createForm}
        title="새 변경 세트"
        description="설정 변경 묶음을 만들고 승인 절차에 올립니다."
        submitLabel="만들기"
        returnFocusRef={createTriggerRef}
        onSubmit={async (values) => {
          await createChangeSet.mutateAsync(values);
          createForm.reset();
        }}
      >
        <FormField label="제목" required error={createForm.formState.errors.title?.message}>
          {(control) => <Input {...control} {...createForm.register("title")} />}
        </FormField>
        <FormField label="설명">
          {(control) => <Textarea {...control} rows={2} {...createForm.register("description")} />}
        </FormField>
        <FormField label="카나리 범위" description="적용 범위 메모로만 기록됩니다.">
          {(control) => <Input {...control} {...createForm.register("canary_scope")} />}
        </FormField>
        <FormField
          label="변경 항목(JSON)"
          description='[{"kind":"setting","key":"clickhouse.url","value":"http://ch:8123"}] 형식입니다. 비밀값과 읽기 전용 설정은 서버가 거부합니다.'
          error={createForm.formState.errors.items?.message}
        >
          {(control) => <Textarea {...control} rows={5} {...createForm.register("items")} />}
        </FormField>
      </FormDialog>

      <Sheet
        open={selected !== undefined}
        onOpenChange={(next) => {
          if (!next) setSelectedId(undefined);
        }}
        size="wide"
        title={selected?.title || selected?.id || "변경 세트"}
        description="변경 세트의 항목과 이전 값을 확인합니다."
        returnFocusRef={rowTriggerRef}
      >
        {selected ? (
          <div className="settings-sheet-stack">
            <KeyValueList
              columns={2}
              items={[
                { label: "ID", value: selected.id, mono: true },
                { label: "상태", value: selected.status ?? "—" },
                { label: "생성자", value: selected.created_by ?? "—" },
                { label: "검토자", value: selected.reviewer ?? "—" },
                { label: "카나리 범위", value: selected.canary_scope ?? "—" },
                { label: "생성", value: formatDateTime(selected.created_at) },
                { label: "수정", value: formatDateTime(selected.updated_at) },
                { label: "적용", value: formatDateTime(selected.applied_at) },
              ]}
            />
            {selected.description ? <p>{selected.description}</p> : null}
            {selected.note ? <p>검토 메모: {selected.note}</p> : null}
            <JsonBlock label="변경 항목" value={selected.items ?? []} />
            <JsonBlock label="적용 전 값(롤백용)" value={selected.prior ?? []} />
          </div>
        ) : null}
      </Sheet>
    </div>
  );
}
