import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";

import { severityTone, skillStatusLabels } from "@/features/agents/skills/skill-form";
import { apiClient } from "@/shared/api/client";
import type { SkillImportResult } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { downloadText } from "@/shared/utils/csv";
import { formatNumber } from "@/shared/utils/format";

interface SkillToolboxProps {
  canWrite: boolean;
  skillsKey: readonly unknown[];
  statusFilter: string;
  writeDisabledReason: string;
}

/**
 * Bulk skill operations. The scan and export calls are expensive server-side
 * sweeps, so they only ever run from an explicit button press — never on render.
 */
export function SkillToolbox({
  canWrite,
  skillsKey,
  statusFilter,
  writeDisabledReason,
}: SkillToolboxProps): React.JSX.Element {
  const queryClient = useQueryClient();
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [seedOpen, setSeedOpen] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [importResult, setImportResult] = useState<SkillImportResult | undefined>();
  const seedButtonRef = useRef<HTMLButtonElement>(null);
  const recommendButtonRef = useRef<HTMLButtonElement>(null);
  const statusQuery = statusFilter === "all" ? {} : { status: statusFilter };

  const scan = useMutation({
    mutationFn: () => apiClient.request(endpoints.domains.agents.skills.scan, { routeId: "agents.skills" }),
  });

  const exportBundle = useMutation({
    mutationFn: () =>
      apiClient.request(endpoints.domains.agents.skills.export, {
        query: statusQuery,
        routeId: "agents.skills",
      }),
    onSuccess: (bundle) => {
      downloadText("skills-bundle.json", JSON.stringify(bundle, null, 2), "application/json;charset=utf-8");
      toast.success("Skill 번들을 내려받았습니다.");
    },
    onError: (error) => toast.error(safeAppErrorMessage(error, "Skill 번들을 내보내지 못했습니다.")),
  });

  const recommend = useMutation({
    mutationFn: (apply: boolean) =>
      apiClient.request(endpoints.domains.agents.skills.recommend, {
        body: {},
        query: { min_count: 3, ...(apply ? { apply: "1" as const } : {}) },
        routeId: "agents.skills",
      }),
    onSuccess: (_result, apply) => {
      if (apply) void queryClient.invalidateQueries({ queryKey: skillsKey });
    },
  });

  const seed = useMutationFeedback({
    mutate: () =>
      apiClient.request(endpoints.domains.agents.skills.seedRecommended, {
        routeId: "agents.skills",
      }),
    invalidates: [skillsKey],
    successMessage: (result) =>
      `추천 Skill ${formatNumber(result.seeded?.length ?? 0)}건을 초안으로 만들었습니다.`,
    errorMessage: "추천 Skill을 시드하지 못했습니다.",
  });

  const importBundle = useMutationFeedback({
    mutate: (body: { version?: string; skills: ReadonlyArray<Record<string, unknown>> }) =>
      apiClient.request(endpoints.domains.agents.skills.import, {
        body,
        routeId: "agents.skills",
      }),
    invalidates: [skillsKey],
    successMessage: "Skill 번들을 가져왔습니다.",
    errorMessage: "Skill 번들을 가져오지 못했습니다.",
    onSuccess: (result) => setImportResult(result),
  });

  const readBundle = async (file: File): Promise<void> => {
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const skills =
        typeof parsed === "object" && parsed !== null && "skills" in parsed
          ? (parsed as { skills?: unknown }).skills
          : parsed;
      if (!Array.isArray(skills)) {
        toast.error("번들 파일에 skills 배열이 없습니다.");
        return;
      }
      const version =
        typeof parsed === "object" && parsed !== null && "version" in parsed
          ? String((parsed as { version?: unknown }).version ?? "")
          : "";
      importBundle.mutate({ version, skills: skills as ReadonlyArray<Record<string, unknown>> });
    } catch {
      toast.error("번들 파일이 올바른 JSON이 아닙니다.");
    }
  };

  return (
    <>
      <div className="agents-detail-actions" role="group" aria-label="Skill 일괄 작업">
        <Button
          ref={seedButtonRef}
          disabled={!canWrite || seed.isPending}
          title={canWrite ? undefined : writeDisabledReason}
          onClick={() => setSeedOpen(true)}
        >
          추천 Skill 시드
        </Button>
        <Button disabled={scan.isPending} onClick={() => scan.mutate()}>
          {scan.isPending ? "스캔 중" : "보안 스캔"}
        </Button>
        <Button
          ref={recommendButtonRef}
          disabled={recommend.isPending}
          onClick={() => recommend.mutate(false)}
        >
          {recommend.isPending ? "분석 중" : "Skill 추천"}
        </Button>
        <Button disabled={exportBundle.isPending} onClick={() => exportBundle.mutate()}>
          {exportBundle.isPending ? "내보내는 중" : "내보내기"}
        </Button>
        <label className="button button-secondary button-default" htmlFor={fileInputId}>
          가져오기
        </label>
        <input
          ref={fileInputRef}
          id={fileInputId}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          disabled={!canWrite}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void readBundle(file);
          }}
        />
      </div>
      {!canWrite ? (
        <InlineNotice tone="info" title="읽기 전용">
          {writeDisabledReason} 스캔·내보내기는 조회 권한으로도 실행할 수 있습니다.
        </InlineNotice>
      ) : null}

      {scan.isError ? (
        <InlineNotice tone="danger" title="보안 스캔에 실패했습니다.">
          {safeAppErrorMessage(scan.error, "보안 스캔을 실행하지 못했습니다.")}
        </InlineNotice>
      ) : null}
      {scan.data ? (
        <SectionCard
          title="보안 스캔 결과"
          headingLevel={3}
          description="high 심각도 발견이 있으면 프로덕션 승격이 차단됩니다."
        >
          <div className="data-table-scroll" tabIndex={0} aria-label="Skill 보안 스캔 표 영역">
            <table className="data-table">
              <caption className="sr-only">Skill 보안 스캔 결과</caption>
              <thead>
                <tr>
                  <th scope="col">Skill</th>
                  <th scope="col">상태</th>
                  <th scope="col">최고 심각도</th>
                  <th scope="col">high</th>
                  <th scope="col">medium</th>
                  <th scope="col">발견 사항</th>
                </tr>
              </thead>
              <tbody>
                {(scan.data.scans ?? []).map((entry) => (
                  <tr key={entry.name ?? ""}>
                    <td>{entry.name ?? "—"}</td>
                    <td>{skillStatusLabels[entry.status ?? ""] ?? entry.status ?? "—"}</td>
                    <td>
                      <Badge tone={severityTone(entry.max_severity)}>{entry.max_severity || "clean"}</Badge>
                    </td>
                    <td className="cell-number">{formatNumber(entry.high_count ?? 0)}</td>
                    <td className="cell-number">{formatNumber(entry.medium_count ?? 0)}</td>
                    <td className="truncate">
                      {(entry.findings ?? [])
                        .map((finding) => `${finding.category ?? ""}: ${finding.detail ?? ""}`)
                        .join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ) : null}

      {recommend.isError ? (
        <InlineNotice tone="danger" title="Skill 추천에 실패했습니다.">
          {safeAppErrorMessage(recommend.error, "Skill 추천을 실행하지 못했습니다.")}
        </InlineNotice>
      ) : null}
      {recommend.data ? (
        <SectionCard
          title="Skill 추천"
          headingLevel={3}
          description={recommend.data.note ?? undefined}
          actions={
            (recommend.data.recommendations ?? []).length > 0 && !recommend.data.applied ? (
              <Button
                size="small"
                variant="primary"
                disabled={!canWrite}
                title={canWrite ? undefined : writeDisabledReason}
                onClick={() => setApplyOpen(true)}
              >
                초안으로 적용
              </Button>
            ) : null
          }
        >
          {(recommend.data.recommendations ?? []).length === 0 ? (
            <p>추천할 새 Skill이 없습니다.</p>
          ) : (
            <div className="data-table-scroll" tabIndex={0} aria-label="Skill 추천 표 영역">
              <table className="data-table">
                <caption className="sr-only">반복 질문에서 도출한 Skill 추천</caption>
                <thead>
                  <tr>
                    <th scope="col">이름</th>
                    <th scope="col">설명</th>
                    <th scope="col">반복</th>
                    <th scope="col">적용</th>
                  </tr>
                </thead>
                <tbody>
                  {(recommend.data.recommendations ?? []).map((entry) => (
                    <tr key={entry.name ?? ""}>
                      <td className="mono">{entry.name ?? "—"}</td>
                      <td className="truncate">{entry.description ?? "—"}</td>
                      <td className="cell-number">{formatNumber(entry.count ?? 0)}</td>
                      <td>{entry.applied ? "적용됨" : "미적용"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      ) : null}

      {importResult ? (
        <InlineNotice
          tone={(importResult.skipped ?? []).length > 0 ? "warning" : "success"}
          title="가져오기 결과"
          actions={
            <Button size="small" onClick={() => setImportResult(undefined)}>
              닫기
            </Button>
          }
        >
          {formatNumber(importResult.imported_count ?? 0)}건을 가져왔습니다.
          {(importResult.skipped ?? []).length > 0
            ? ` 건너뜀: ${(importResult.skipped ?? [])
                .map((entry) => `${entry.name ?? ""}(${entry.reason ?? ""})`)
                .join(", ")}`
            : ""}
        </InlineNotice>
      ) : null}

      <ConfirmDialog
        title="추천 Skill 시드"
        description="내장 추천 Skill 3종을 초안(draft) 상태로 만듭니다. 이미 있으면 덮어쓰지 않고 갱신합니다."
        confirmLabel="시드 실행"
        open={seedOpen}
        onOpenChange={setSeedOpen}
        onConfirm={async () => {
          await seed.mutateAsync(undefined);
        }}
        returnFocusRef={seedButtonRef}
      />

      <ConfirmDialog
        title="추천을 초안으로 적용"
        description="추천된 Skill을 초안(draft) 상태로 만듭니다. 프로덕션 승격은 별도 게이트를 통과해야 합니다."
        confirmLabel="초안 생성"
        open={applyOpen}
        onOpenChange={setApplyOpen}
        onConfirm={async () => {
          await recommend.mutateAsync(true);
        }}
        returnFocusRef={recommendButtonRef}
      />
    </>
  );
}
