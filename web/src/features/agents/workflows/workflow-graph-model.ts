import type { WorkflowDefinition } from "@/shared/api/generated";
import {
  workflowGraphInputSchema,
  type GraphInput,
  type GraphStep,
} from "@/shared/api/domains/workflow-graph.schemas";

export const graphEnd = "$end";
export const graphTypes = [
  "chat",
  "skill",
  "text2sql",
  "mcp_tool",
  "condition",
  "approval",
  "transform",
] as const;
export const graphTypeLabels: Record<GraphStep["type"], string> = {
  chat: "채팅",
  skill: "스킬",
  text2sql: "자연어 SQL 미리보기",
  mcp_tool: "MCP 도구 호출",
  condition: "조건 분기",
  approval: "승인 대기",
  transform: "입력 전달",
};
export const graphWhenLabels = { next: "다음", true: "참일 때", false: "거짓일 때" } as const;

export function graphRequestWithinLimit(workflow: GraphInput, reason: string, revision: string): boolean {
  return (
    new TextEncoder().encode(JSON.stringify({ workflow, reason, expected_revision: revision })).length <=
    256 * 1024
  );
}

export function graphDraft(definition?: WorkflowDefinition): GraphInput {
  if (definition?.flow) return workflowGraphInputSchema.parse(definition);
  const steps: GraphStep[] = (
    definition?.steps?.length ? definition.steps : [{ name: "입력 전달", type: "transform" }]
  ).map((step, index) => {
    if (!graphTypes.includes(step.type as GraphStep["type"]))
      throw new Error("지원하지 않는 단계 종류가 있어 분기로 전환할 수 없습니다.");
    return {
      id: `step_${index + 1}`,
      name: step.name,
      type: step.type as GraphStep["type"],
      ...(step.ref ? { ref: step.ref } : {}),
      ...(step.note ? { note: step.note } : {}),
      ...(step.timeout_ms !== undefined ? { timeout_ms: step.timeout_ms } : {}),
      ...(["chat", "skill"].includes(step.type) && step.max_tokens !== undefined
        ? { max_tokens: step.max_tokens }
        : {}),
      ...(step.type === "mcp_tool" && step.allowed_tools ? { allowed_tools: step.allowed_tools } : {}),
      ...(step.type === "condition" ? { condition: { operator: "non_empty" } as const } : {}),
    };
  });
  return {
    id:
      definition?.id ??
      `wf_${Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
    name: definition?.name ?? "",
    description: definition?.description ?? "",
    allowed_teams: definition?.allowed_teams ?? "",
    enabled: false,
    steps,
    flow: {
      version: 1,
      entry: steps[0]?.id ?? "",
      edges: steps.flatMap<GraphInput["flow"]["edges"][number]>((step, index) => {
        const to = step.type === "approval" ? graphEnd : (steps[index + 1]?.id ?? graphEnd);
        return step.type === "condition"
          ? [
              { from: step.id, to, when: "true" as const },
              { from: step.id, to: graphEnd, when: "false" as const },
            ]
          : [{ from: step.id, to, when: "next" as const }];
      }),
    },
  };
}

export function graphIssues(draft: GraphInput): string[] {
  const issues: string[] = [];
  const schema = workflowGraphInputSchema.safeParse(draft);
  if (!schema.success) issues.push("이름·단계·시간·토큰 값과 최대 128단계 제한을 확인하세요.");
  const ids = new Set(draft.steps.map((step) => step.id));
  if (ids.size !== draft.steps.length) issues.push("단계 식별자가 중복되었습니다.");
  if (!ids.has(draft.flow.entry)) issues.push("시작 단계를 선택하세요.");
  const next = new Map<string, string[]>();
  for (const step of draft.steps) {
    const edges = draft.flow.edges.filter((edge) => edge.from === step.id);
    const labels = step.type === "condition" ? ["true", "false"] : ["next"];
    if (
      edges.length !== labels.length ||
      labels.some((label) => edges.filter((edge) => edge.when === label).length !== 1)
    )
      issues.push(`${step.name || step.id}: 연결을 빠짐없이 지정하세요.`);
    for (const edge of edges) {
      if (edge.to !== graphEnd && !ids.has(edge.to))
        issues.push(`${step.name || step.id}: 연결 대상이 없습니다.`);
      if (step.type === "approval" && edge.to !== graphEnd)
        issues.push("승인 대기는 현재 재개를 지원하지 않아 종료에 연결해야 합니다.");
    }
    next.set(
      step.id,
      edges.map((edge) => edge.to),
    );
    if (step.type === "condition") {
      if (!step.condition || (step.condition.operator === "contains" && !step.condition.value))
        issues.push(`${step.name || step.id}: 비교 조건을 입력하세요.`);
      if (new TextEncoder().encode(step.condition?.value ?? "").length > 4096)
        issues.push("비교 값은 4096바이트 이하여야 합니다.");
    } else if (step.condition) issues.push("조건식은 조건 분기에만 지정할 수 있습니다.");
    if (step.max_tokens && !["chat", "skill"].includes(step.type))
      issues.push("토큰 제한은 채팅·스킬 단계에만 적용됩니다.");
    if (step.allowed_tools?.length && step.type !== "mcp_tool")
      issues.push("허용 도구는 MCP 단계에만 적용됩니다.");
    if (step.type === "mcp_tool" && !step.ref?.trim()) issues.push("MCP 도구의 전체 이름을 입력하세요.");
    if (step.type === "skill" && !step.ref?.trim()) issues.push("스킬 참조 이름을 입력하세요.");
  }
  if (draft.flow.edges.some((edge) => !ids.has(edge.from)))
    issues.push("삭제된 단계의 연결이 남아 있습니다.");
  const colors = new Map<string, number>();
  const visit = (id: string): boolean => {
    if (id === graphEnd || colors.get(id) === 2 || !ids.has(id)) return true;
    if (colors.get(id) === 1) return false;
    colors.set(id, 1);
    if ((next.get(id) ?? []).some((target) => !visit(target))) return false;
    colors.set(id, 2);
    return true;
  };
  if (!visit(draft.flow.entry))
    issues.push("순환 연결은 지원하지 않습니다. 이전 단계로 돌아가는 연결을 수정하세요.");
  else if (colors.size !== ids.size) issues.push("시작 단계에서 도달할 수 없는 단계가 있습니다.");
  return [...new Set(issues)];
}

export function changeGraphType(draft: GraphInput, id: string, type: GraphStep["type"]): GraphInput {
  const steps = draft.steps.map((step): GraphStep =>
    step.id === id
      ? {
          id,
          name: step.name,
          type,
          ...(step.note ? { note: step.note } : {}),
          ...(type === "condition" ? { condition: { operator: "non_empty" } as const } : {}),
        }
      : step,
  );
  return {
    ...draft,
    steps,
    flow: {
      ...draft.flow,
      edges: [
        ...draft.flow.edges.filter((edge) => edge.from !== id),
        ...(type === "condition"
          ? [
              { from: id, to: graphEnd, when: "true" as const },
              { from: id, to: graphEnd, when: "false" as const },
            ]
          : [{ from: id, to: graphEnd, when: "next" as const }]),
      ],
    },
  };
}

export function addGraphStep(draft: GraphInput): GraphInput {
  if (draft.steps.length >= 128) return draft;
  let index = 1;
  while (draft.steps.some((step) => step.id === `step_${index}`)) index++;
  const id = `step_${index}`;
  return {
    ...draft,
    steps: [...draft.steps, { id, name: `새 단계 ${index}`, type: "transform" }],
    flow: { ...draft.flow, edges: [...draft.flow.edges, { from: id, to: graphEnd, when: "next" }] },
  };
}

export function removeGraphStep(draft: GraphInput, id: string): GraphInput {
  return {
    ...draft,
    steps: draft.steps.filter((step) => step.id !== id),
    flow: {
      ...draft.flow,
      entry: draft.flow.entry === id ? "" : draft.flow.entry,
      edges: draft.flow.edges.filter((edge) => edge.from !== id),
    },
  };
}
