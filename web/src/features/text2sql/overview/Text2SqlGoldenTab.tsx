import { useRef, useState } from "react";
import { z } from "zod";

import { ReadOnlyNotice } from "@/features/text2sql/overview/text2sql-presentation";
import { clip, writeDisabledTitle } from "@/features/text2sql/overview/text2sql-labels";
import { text2sqlInvalidations, text2sqlRouteId } from "@/features/text2sql/overview/use-text2sql-queries";
import { apiClient } from "@/shared/api/client";
import type { Text2SQLGoldenRow, Text2SQLGoldenRun } from "@/shared/api/domains/text2sql";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatNumber, formatPercent } from "@/shared/utils/format";

const goldenFormSchema = z.object({
  name: z.string().trim().min(1, "이름을 입력하세요."),
  question: z.string().trim().min(1, "자연어 질문을 입력하세요."),
  expected_sql: z.string().trim().min(1, "검증된 기대 SQL을 입력하세요."),
  schema_name: z.string().trim(),
  tags: z.string(),
});
type GoldenFormValues = z.infer<typeof goldenFormSchema>;

interface Text2SqlGoldenTabProps {
  canWrite: boolean;
  golden: readonly Text2SQLGoldenRow[];
  loading: boolean;
}

export function Text2SqlGoldenTab({ canWrite, golden, loading }: Text2SqlGoldenTabProps): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toDelete, setToDelete] = useState("");
  const [runConfirmOpen, setRunConfirmOpen] = useState(false);
  const [runResult, setRunResult] = useState<Text2SQLGoldenRun | undefined>();
  const createTriggerRef = useRef<HTMLButtonElement>(null);
  const runTriggerRef = useRef<HTMLButtonElement>(null);
  const rowTriggerRef = useRef<HTMLElement | null>(null);

  const form = useZodForm<GoldenFormValues, GoldenFormValues>(goldenFormSchema, {
    name: "",
    question: "",
    expected_sql: "",
    schema_name: "",
    tags: "",
  });

  const save = useMutationFeedback({
    mutate: (values: GoldenFormValues) =>
      apiClient.request(endpoints.domains.text2sql.golden.save, {
        body: {
          name: values.name,
          question: values.question,
          expected_sql: values.expected_sql,
          schema_name: values.schema_name,
          tags: values.tags
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          enabled: true,
        },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.overview,
    successMessage: "Golden Query를 저장했습니다.",
  });
  const remove = useMutationFeedback({
    mutate: (id: string) =>
      apiClient.request(endpoints.domains.text2sql.golden.remove, {
        query: { id },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.overview,
    successMessage: "Golden Query를 삭제했습니다.",
  });
  const run = useMutationFeedback({
    mutate: () =>
      apiClient.request(endpoints.domains.text2sql.golden.run, {
        body: {},
        routeId: text2sqlRouteId,
        timeoutMs: 120_000,
      }),
    successMessage: (result) =>
      `회귀 검증 완료 — 통과 ${result.passed}/${result.total} (${formatPercent(result.pass_rate, 0)})`,
    onSuccess: (result) => setRunResult(result),
  });

  const column = createDataTableColumnHelper<Text2SQLGoldenRow>();
  const columns = column.columns([
    column.accessor((row) => row.name, {
      id: "name",
      header: "이름",
      cell: ({ row }) => (
        <div className="t2s-cell-stack">
          <strong>{row.original.name}</strong>
          <span className="badge-list">
            {row.original.source === "auto" ? <Badge tone="info">자동 후보</Badge> : null}
            {row.original.enabled ? null : <Badge tone="danger">중지</Badge>}
            {row.original.tags.map((tag) => (
              <Badge key={tag} tone="muted">
                {tag}
              </Badge>
            ))}
          </span>
        </div>
      ),
    }),
    column.accessor((row) => row.question, {
      id: "question",
      header: "질문",
      cell: ({ getValue }) => <span className="truncate">{clip(getValue(), 60)}</span>,
    }),
    column.accessor((row) => row.expected_sql, {
      id: "sql",
      header: "기대 SQL",
      cell: ({ getValue }) => <code className="mono truncate">{clip(getValue(), 80)}</code>,
    }),
    column.accessor((row) => row.schema_name, {
      id: "schema",
      header: "스키마",
      cell: ({ getValue }) => getValue() || "기본",
    }),
    column.display({
      id: "actions",
      header: "동작",
      cell: ({ row }) => (
        <Button
          size="small"
          variant="danger"
          disabled={!canWrite}
          title={writeDisabledTitle(canWrite)}
          onClick={(event) => {
            rowTriggerRef.current = event.currentTarget;
            setToDelete(row.original.id);
          }}
        >
          삭제
        </Button>
      ),
    }),
  ]) as Array<DataTableColumn<Text2SQLGoldenRow>>;

  const resultColumn = createDataTableColumnHelper<Text2SQLGoldenRun["results"][number]>();
  const resultColumns = resultColumn.columns([
    resultColumn.accessor((row) => row.name, { id: "name", header: "Golden Query" }),
    resultColumn.accessor((row) => row.passed, {
      id: "passed",
      header: "판정",
      cell: ({ getValue }) => (
        <Badge tone={getValue() ? "success" : "danger"}>{getValue() ? "통과" : "실패"}</Badge>
      ),
    }),
    resultColumn.accessor((row) => row.valid, {
      id: "valid",
      header: "SQL 검증",
      cell: ({ row }) =>
        row.original.valid ? (
          <Badge tone="success">유효</Badge>
        ) : (
          <Badge tone="danger">{clip(row.original.reject_reason || "거부", 40)}</Badge>
        ),
    }),
    resultColumn.accessor((row) => row.token_match, {
      id: "token_match",
      header: "토큰 일치",
      cell: ({ getValue }) => (getValue() ? "일치" : "불일치"),
    }),
    resultColumn.display({
      id: "result_match",
      header: "결과 일치",
      cell: ({ row }) =>
        row.original.result_match === null || row.original.result_match === undefined
          ? "확인 안 함"
          : row.original.result_match
            ? "일치"
            : `불일치${row.original.result_detail ? ` — ${clip(row.original.result_detail, 40)}` : ""}`,
    }),
    resultColumn.accessor((row) => row.generated_sql, {
      id: "generated_sql",
      header: "생성 SQL",
      cell: ({ getValue }) => <code className="mono truncate">{clip(getValue(), 80) || "—"}</code>,
    }),
  ]) as Array<DataTableColumn<Text2SQLGoldenRun["results"][number]>>;

  return (
    <div className="t2s-stack">
      <ReadOnlyNotice canWrite={canWrite} />

      <SectionCard
        title="Golden Query (few-shot · 회귀)"
        description="등록한 질문과 검증된 SQL은 생성 프롬프트의 few-shot 예시로 주입되고 회귀 검증에 사용됩니다."
        actions={
          <>
            <Button
              ref={runTriggerRef}
              disabled={!canWrite || run.isPending}
              title={writeDisabledTitle(canWrite)}
              onClick={() => setRunConfirmOpen(true)}
            >
              {run.isPending ? "실행 중" : "회귀 검증 실행"}
            </Button>
            <Button
              ref={createTriggerRef}
              variant="primary"
              disabled={!canWrite}
              title={writeDisabledTitle(canWrite)}
              onClick={() => setDialogOpen(true)}
            >
              Golden Query 추가
            </Button>
          </>
        }
      >
        <DataTable
          caption="Text2SQL Golden Query"
          columns={columns}
          data={golden}
          loading={loading}
          getRowId={(row) => row.id}
          emptyMessage="Golden Query가 없습니다. 등록하면 few-shot 예시와 회귀 검증 기준으로 쓰입니다."
        />
      </SectionCard>

      {runResult ? (
        <SectionCard title="회귀 검증 결과" description="결과는 이 화면에서만 표시하며 저장하지 않습니다.">
          <InlineNotice tone={runResult.passed === runResult.total ? "success" : "warning"}>
            모델 <code className="mono">{runResult.model}</code> — 통과 {formatNumber(runResult.passed)}/
            {formatNumber(runResult.total)} ({formatPercent(runResult.pass_rate, 0)})
            {runResult.result_checked !== null && runResult.result_checked !== undefined
              ? ` · 결과 일치 ${formatNumber(runResult.result_matched ?? 0)}/${formatNumber(runResult.result_checked)}`
              : ""}
          </InlineNotice>
          <DataTable
            caption="회귀 검증 상세 결과"
            columns={resultColumns}
            data={runResult.results}
            getRowId={(row, index) => row.id || `${row.name}-${index}`}
            emptyMessage="실행된 Golden Query가 없습니다."
          />
        </SectionCard>
      ) : null}

      <FormDialog
        open={dialogOpen}
        onOpenChange={(next) => {
          setDialogOpen(next);
          if (!next) form.reset();
        }}
        form={form}
        returnFocusRef={createTriggerRef}
        title="Golden Query 추가"
        description="자연어 질문과 검증된 기대 SQL을 한 쌍으로 등록합니다."
        onSubmit={async (values) => {
          await save.mutateAsync(values);
        }}
      >
        <FormField label="이름" required error={form.formState.errors.name?.message}>
          {(control) => <Input {...control} {...form.register("name")} />}
        </FormField>
        <FormField label="자연어 질문" required error={form.formState.errors.question?.message}>
          {(control) => <Textarea {...control} rows={3} {...form.register("question")} />}
        </FormField>
        <FormField label="기대 SQL" required error={form.formState.errors.expected_sql?.message}>
          {(control) => <Textarea {...control} rows={5} {...form.register("expected_sql")} />}
        </FormField>
        <FormField label="스키마명" error={form.formState.errors.schema_name?.message}>
          {(control) => <Input {...control} {...form.register("schema_name")} />}
        </FormField>
        <FormField label="태그" description="콤마로 구분합니다." error={form.formState.errors.tags?.message}>
          {(control) => <Input {...control} {...form.register("tags")} />}
        </FormField>
      </FormDialog>

      <ConfirmDialog
        open={runConfirmOpen}
        onOpenChange={setRunConfirmOpen}
        returnFocusRef={runTriggerRef}
        title="Golden Query 회귀 검증 실행"
        description="사용 중인 모델로 모든 활성 Golden Query의 SQL을 다시 생성합니다. 모델 호출 비용이 발생하며 시간이 걸릴 수 있습니다."
        confirmLabel="실행"
        onConfirm={async () => {
          await run.mutateAsync();
        }}
      />

      <ConfirmDialog
        open={toDelete !== ""}
        onOpenChange={(next) => {
          if (!next) setToDelete("");
        }}
        returnFocusRef={rowTriggerRef}
        tone="danger"
        title="Golden Query 삭제"
        description="삭제하면 few-shot 예시와 회귀 검증 대상에서 함께 빠집니다."
        confirmLabel="삭제"
        onConfirm={async () => {
          await remove.mutateAsync(toDelete);
          setToDelete("");
        }}
      />
    </div>
  );
}
