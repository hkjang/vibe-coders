import { useRef, useState } from "react";
import { Play, Plus, Trash2 } from "lucide-react";
import { z } from "zod";

import {
  useModelContracts,
  useModelDeprecations,
  useModelGovernanceMutations,
} from "@/features/gateway/models/use-model-governance";
import type { ModelContractRun } from "@/shared/api/domains/gateway.schemas";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatNumber } from "@/shared/utils/format";

const optionalNumber = (label: string) =>
  z
    .string()
    .trim()
    .refine((value) => value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0), {
      message: `${label}은(는) 0 이상의 숫자여야 합니다.`,
    });

const contractSchema = z.object({
  name: z.string().trim().min(1, "계약 이름을 입력하세요.").max(200),
  task_type: z.string().trim().max(120).default(""),
  min_quality_score: optionalNumber("품질 점수"),
  min_golden_pass_rate: optionalNumber("골든 통과율"),
  min_success_rate: optionalNumber("성공률"),
  max_latency_ms: optionalNumber("지연 상한"),
  max_avg_cost_krw: optionalNumber("평균 비용 상한"),
  enabled: z.boolean().default(true),
});
type ContractInput = z.input<typeof contractSchema>;
type ContractOutput = z.output<typeof contractSchema>;

const deprecationSchema = z.object({
  model_glob: z.string().trim().min(1, "모델 패턴을 입력하세요.").max(200),
  replacement: z.string().trim().max(200).default(""),
  sunset_date: z
    .string()
    .trim()
    .refine((value) => value === "" || /^\d{4}-\d{2}-\d{2}$/u.test(value), "YYYY-MM-DD 형식으로 입력하세요.")
    .default(""),
  message: z.string().trim().max(1000).default(""),
});
type DeprecationInput = z.input<typeof deprecationSchema>;
type DeprecationOutput = z.output<typeof deprecationSchema>;

const verdictTone: Record<string, "success" | "warning" | "danger" | "muted"> = {
  pass: "success",
  warn: "warning",
  fail: "danger",
  no_data: "muted",
};

const verdictLabels: Record<string, string> = {
  pass: "충족",
  warn: "주의",
  fail: "미달",
  no_data: "데이터 부족",
};

interface GovernanceProps {
  canWrite: boolean;
  writeDeniedReason: string;
}

export function ModelContractsPanel({ canWrite, writeDeniedReason }: GovernanceProps): React.JSX.Element {
  const contracts = useModelContracts();
  const { removeContract, runContract, saveContract } = useModelGovernanceMutations();
  const [formOpen, setFormOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | undefined>();
  const [runModel, setRunModel] = useState("");
  const [runResult, setRunResult] = useState<ModelContractRun | undefined>();
  const createRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const form = useZodForm<ContractInput, ContractOutput>(contractSchema, {
    name: "",
    task_type: "",
    min_quality_score: "",
    min_golden_pass_rate: "",
    min_success_rate: "",
    max_latency_ms: "",
    max_avg_cost_krw: "",
    enabled: true,
  });

  return (
    <div className="page-stack">
      <SectionCard
        title="모델 계약"
        description="작업 유형별로 모델이 만족해야 하는 품질·지연·비용 기준입니다. 모델 교체 전에 안전 여부를 판단하는 근거가 됩니다."
        actions={
          <Button
            ref={createRef}
            size="small"
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={() => {
              returnFocusRef.current = createRef.current;
              form.reset({
                name: "",
                task_type: "",
                min_quality_score: "",
                min_golden_pass_rate: "",
                min_success_rate: "",
                max_latency_ms: "",
                max_avg_cost_krw: "",
                enabled: true,
              });
              setFormOpen(true);
            }}
          >
            <Plus aria-hidden="true" /> 계약 추가
          </Button>
        }
      >
        {!canWrite ? (
          <InlineNotice tone="warning" title="쓰기 권한이 없습니다.">
            {writeDeniedReason}
          </InlineNotice>
        ) : null}
        {contracts.isPending ? (
          <LoadingState label="모델 계약을 불러오는 중입니다." />
        ) : contracts.isError ? (
          <InlineNotice tone="danger" title="모델 계약을 불러오지 못했습니다.">
            {safeAppErrorMessage(contracts.error, "권한 또는 네트워크 상태를 확인하세요.")}
            <Button size="small" variant="ghost" onClick={() => void contracts.refetch()}>
              다시 시도
            </Button>
          </InlineNotice>
        ) : contracts.data.contracts.length === 0 ? (
          <EmptyState
            title="등록된 모델 계약이 없습니다."
            description="작업 유형별 최소 품질과 최대 비용을 계약으로 등록하면 모델 교체를 자동으로 검증할 수 있습니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="모델 계약 표 영역">
            <table className="data-table">
              <caption className="sr-only">작업 유형별 모델 계약</caption>
              <thead>
                <tr>
                  <th scope="col">이름</th>
                  <th scope="col">작업 유형</th>
                  <th scope="col">품질 ≥</th>
                  <th scope="col">골든 ≥</th>
                  <th scope="col">성공률 ≥</th>
                  <th scope="col">지연 ≤</th>
                  <th scope="col">비용 ≤</th>
                  <th scope="col">사용</th>
                  <th scope="col">작업</th>
                </tr>
              </thead>
              <tbody>
                {contracts.data.contracts.map((contract) => (
                  <tr key={contract.id}>
                    <td>{contract.name}</td>
                    <td>{contract.task_type || "-"}</td>
                    <td className="cell-number">{formatNumber(contract.min_quality_score ?? 0, 1)}</td>
                    <td className="cell-number">{formatNumber(contract.min_golden_pass_rate ?? 0, 2)}</td>
                    <td className="cell-number">{formatNumber(contract.min_success_rate ?? 0, 2)}</td>
                    <td className="cell-number">{formatNumber(contract.max_latency_ms ?? 0)} ms</td>
                    <td className="cell-number">{formatNumber(contract.max_avg_cost_krw ?? 0, 2)}</td>
                    <td>
                      <Badge tone={contract.enabled ? "success" : "muted"}>
                        {contract.enabled ? "사용" : "중지"}
                      </Badge>
                    </td>
                    <td>
                      <div className="gateway-row-actions">
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={!canWrite}
                          title={canWrite ? undefined : writeDeniedReason}
                          onClick={() => {
                            returnFocusRef.current = createRef.current;
                            form.reset({
                              name: contract.name,
                              task_type: contract.task_type ?? "",
                              min_quality_score: String(contract.min_quality_score ?? ""),
                              min_golden_pass_rate: String(contract.min_golden_pass_rate ?? ""),
                              min_success_rate: String(contract.min_success_rate ?? ""),
                              max_latency_ms: String(contract.max_latency_ms ?? ""),
                              max_avg_cost_krw: String(contract.max_avg_cost_krw ?? ""),
                              enabled: contract.enabled ?? true,
                            });
                            setFormOpen(true);
                          }}
                        >
                          수정
                        </Button>
                        <Button
                          size="small"
                          variant="ghost"
                          disabled={!canWrite}
                          title={canWrite ? undefined : writeDeniedReason}
                          onClick={() => setRemoveTarget({ id: contract.id, name: contract.name })}
                        >
                          <Trash2 aria-hidden="true" /> 삭제
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="계약 검증 실행"
        description="후보 모델의 관측 지표를 계약 임계값과 비교합니다. 실패 샘플은 원문 없이 지문과 사유만 표시합니다."
      >
        <div className="toolbar">
          <div className="toolbar-start">
            <FormField label="검증할 모델" id="model-contract-run-model">
              {(control) => (
                <Input {...control} value={runModel} onChange={(event) => setRunModel(event.target.value)} />
              )}
            </FormField>
            <Button
              variant="secondary"
              disabled={!canWrite || runModel.trim() === "" || runContract.isPending}
              title={canWrite ? undefined : writeDeniedReason}
              onClick={() => {
                void runContract
                  .mutateAsync({ model: runModel.trim() })
                  .then((result) => setRunResult(result))
                  .catch(() => setRunResult(undefined));
              }}
            >
              <Play aria-hidden="true" /> 계약 검증 실행
            </Button>
          </div>
        </div>
        {runResult ? (
          <div className="page-stack">
            <InlineNotice tone={runResult.replaceable ? "success" : "warning"} title="검증 결과">
              {runResult.replaceable
                ? "모든 활성 계약을 충족합니다."
                : "일부 계약을 충족하지 못했습니다. 교체 전에 지표를 확인하세요."}
            </InlineNotice>
            <ul className="gateway-list">
              {runResult.results.map((result, index) => (
                <li key={`${result.contract_id ?? "contract"}-${index}`}>
                  <strong>
                    {result.contract_name || result.contract_id}{" "}
                    <Badge tone={verdictTone[result.verdict ?? "no_data"] ?? "muted"}>
                      {verdictLabels[result.verdict ?? "no_data"] ?? result.verdict}
                    </Badge>
                  </strong>
                  <span>
                    {(result.checks ?? [])
                      .map(
                        (check) =>
                          `${check.dimension ?? ""} ${verdictLabels[check.status ?? ""] ?? check.status ?? ""}`,
                      )
                      .join(" · ") || "검사 항목 없음"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </SectionCard>

      <FormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={returnFocusRef}
        form={form}
        title="모델 계약"
        description="0을 넣거나 비우면 해당 기준은 검사하지 않습니다."
        onSubmit={(values) =>
          saveContract.mutateAsync({
            name: values.name,
            task_type: values.task_type || undefined,
            min_quality_score: values.min_quality_score === "" ? 0 : Number(values.min_quality_score),
            min_golden_pass_rate:
              values.min_golden_pass_rate === "" ? 0 : Number(values.min_golden_pass_rate),
            min_success_rate: values.min_success_rate === "" ? 0 : Number(values.min_success_rate),
            max_latency_ms: values.max_latency_ms === "" ? 0 : Number(values.max_latency_ms),
            max_avg_cost_krw: values.max_avg_cost_krw === "" ? 0 : Number(values.max_avg_cost_krw),
            enabled: values.enabled,
          })
        }
      >
        <FormField label="이름" required error={form.formState.errors.name?.message}>
          {(control) => <Input {...control} {...form.register("name")} />}
        </FormField>
        <FormField label="작업 유형" description="예: code_review, sql, summary">
          {(control) => <Input {...control} {...form.register("task_type")} />}
        </FormField>
        <FormField label="최소 품질 점수 (0~100)" error={form.formState.errors.min_quality_score?.message}>
          {(control) => <Input {...control} inputMode="decimal" {...form.register("min_quality_score")} />}
        </FormField>
        <FormField label="최소 골든 통과율 (0~1)">
          {(control) => <Input {...control} inputMode="decimal" {...form.register("min_golden_pass_rate")} />}
        </FormField>
        <FormField label="최소 성공률 (0~1)">
          {(control) => <Input {...control} inputMode="decimal" {...form.register("min_success_rate")} />}
        </FormField>
        <FormField label="최대 평균 지연(ms)">
          {(control) => <Input {...control} inputMode="numeric" {...form.register("max_latency_ms")} />}
        </FormField>
        <FormField label="최대 평균 비용(원)">
          {(control) => <Input {...control} inputMode="decimal" {...form.register("max_avg_cost_krw")} />}
        </FormField>
        <Checkbox label="계약 사용" {...form.register("enabled")} />
      </FormDialog>

      <ConfirmDialog
        open={removeTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(undefined);
        }}
        returnFocusRef={returnFocusRef}
        tone="danger"
        title="모델 계약 삭제"
        description={`${removeTarget?.name ?? ""} 계약을 삭제합니다. 이후 검증에서 제외됩니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (!removeTarget) return;
          await removeContract.mutateAsync(removeTarget.id);
          setRemoveTarget(undefined);
        }}
      />
    </div>
  );
}

export function ModelDeprecationsPanel({ canWrite, writeDeniedReason }: GovernanceProps): React.JSX.Element {
  const deprecations = useModelDeprecations();
  const { removeDeprecation, saveDeprecation } = useModelGovernanceMutations();
  const [formOpen, setFormOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; glob: string } | undefined>();
  const createRef = useRef<HTMLButtonElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const form = useZodForm<DeprecationInput, DeprecationOutput>(deprecationSchema, {
    model_glob: "",
    replacement: "",
    sunset_date: "",
    message: "",
  });

  return (
    <div className="page-stack">
      <SectionCard
        title="모델 지원 종료"
        description="종료 예정 모델을 경고하거나 지정한 날짜 이후 대체 모델로 다시 쓰거나 차단합니다."
        actions={
          <Button
            ref={createRef}
            size="small"
            variant="primary"
            disabled={!canWrite}
            title={canWrite ? undefined : writeDeniedReason}
            onClick={() => {
              returnFocusRef.current = createRef.current;
              form.reset({ model_glob: "", replacement: "", sunset_date: "", message: "" });
              setFormOpen(true);
            }}
          >
            <Plus aria-hidden="true" /> 정책 추가
          </Button>
        }
      >
        {!canWrite ? (
          <InlineNotice tone="warning" title="쓰기 권한이 없습니다.">
            {writeDeniedReason}
          </InlineNotice>
        ) : null}
        {deprecations.isPending ? (
          <LoadingState label="지원 종료 정책을 불러오는 중입니다." />
        ) : deprecations.isError ? (
          <InlineNotice tone="danger" title="지원 종료 정책을 불러오지 못했습니다.">
            {safeAppErrorMessage(deprecations.error, "권한 또는 네트워크 상태를 확인하세요.")}
          </InlineNotice>
        ) : deprecations.data.deprecations.length === 0 ? (
          <EmptyState
            title="등록된 지원 종료 정책이 없습니다."
            description="곧 사라질 모델을 등록하면 호출자에게 미리 경고하고 종료일에 자동으로 대체할 수 있습니다."
          />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="모델 지원 종료 정책 표 영역">
            <table className="data-table">
              <caption className="sr-only">모델 지원 종료 정책</caption>
              <thead>
                <tr>
                  <th scope="col">모델 패턴</th>
                  <th scope="col">대체 모델</th>
                  <th scope="col">종료일</th>
                  <th scope="col">안내 문구</th>
                  <th scope="col">작업</th>
                </tr>
              </thead>
              <tbody>
                {deprecations.data.deprecations.map((item) => (
                  <tr key={item.id}>
                    <td className="mono">{item.model_glob}</td>
                    <td>{item.replacement || "차단"}</td>
                    <td>{item.sunset_date || "경고만"}</td>
                    <td className="truncate">{item.message || "-"}</td>
                    <td>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={!canWrite}
                        title={canWrite ? undefined : writeDeniedReason}
                        onClick={() => setRemoveTarget({ id: item.id, glob: item.model_glob })}
                      >
                        <Trash2 aria-hidden="true" /> 삭제
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <FormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        returnFocusRef={returnFocusRef}
        form={form}
        title="지원 종료 정책"
        description="대체 모델을 비우면 종료일 이후 호출을 차단합니다."
        onSubmit={(values) =>
          saveDeprecation.mutateAsync({
            model_glob: values.model_glob,
            replacement: values.replacement || undefined,
            sunset_date: values.sunset_date || undefined,
            message: values.message || undefined,
          })
        }
      >
        <FormField label="모델 패턴" required error={form.formState.errors.model_glob?.message}>
          {(control) => <Input {...control} {...form.register("model_glob")} />}
        </FormField>
        <FormField label="대체 모델" description="비우면 종료일 이후 차단합니다.">
          {(control) => <Input {...control} {...form.register("replacement")} />}
        </FormField>
        <FormField
          label="종료일"
          description="YYYY-MM-DD. 비우면 경고만 표시합니다."
          error={form.formState.errors.sunset_date?.message}
        >
          {(control) => <Input {...control} placeholder="2026-12-31" {...form.register("sunset_date")} />}
        </FormField>
        <FormField label="안내 문구">
          {(control) => <Textarea {...control} rows={2} {...form.register("message")} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={removeTarget !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoveTarget(undefined);
        }}
        returnFocusRef={returnFocusRef}
        tone="danger"
        title="지원 종료 정책 삭제"
        description={`${removeTarget?.glob ?? ""} 정책을 삭제합니다. 해당 모델의 경고와 자동 대체가 즉시 중단됩니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          if (!removeTarget) return;
          await removeDeprecation.mutateAsync(removeTarget.id);
          setRemoveTarget(undefined);
        }}
      />
    </div>
  );
}
