import type {
  DynamicRouteElement,
  DynamicRouteElementType,
  DynamicRouteGraph,
  DynamicRouteStep,
} from "@/shared/api/domains/routing-dynamic";

/**
 * Pure helpers behind the dynamic route editor: labels, summaries, the column
 * layout of the flow, immutable graph edits and starter templates. Nothing here
 * talks to the server; the server stays the authority on validation.
 */

export const elementTypeLabels: Readonly<Record<DynamicRouteElementType, string>> = {
  start: "시작",
  conditional: "조건",
  percentage: "비율 분배",
  rate: "한도",
  model: "모델",
  end: "종료",
};

export const elementTypeHints: Readonly<Record<DynamicRouteElementType, string>> = {
  start: "요청이 들어오는 곳입니다. 경로마다 하나만 있습니다.",
  conditional: "메타데이터나 호출 키 정보로 참·거짓 두 갈래로 나눕니다.",
  percentage: "트래픽을 비율대로 나눕니다. A/B 시험이나 점진 전환에 씁니다.",
  rate: "요청 수나 비용이 기간 한도를 넘으면 다른 갈래로 보냅니다.",
  model: "모델 하나를 호출합니다. 실패하면 fallback 갈래로 넘어갑니다.",
  end: "마지막으로 성공한 모델의 응답을 돌려줍니다.",
};

export const addableTypes: readonly DynamicRouteElementType[] = [
  "model",
  "conditional",
  "percentage",
  "rate",
  "end",
];

/** The outputs an element of this type can have, in display order. */
export function outputNames(element: DynamicRouteElement): string[] {
  switch (element.type) {
    case "start":
      return ["next"];
    case "conditional":
      return ["true", "false"];
    case "rate":
    case "model":
      return ["success", "fallback"];
    case "percentage":
      return percentKeys(element);
    case "end":
      return [];
  }
}

export function percentValue(key: string): number {
  const parsed = Number.parseFloat(key.replace(/%$/u, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function percentKeys(element: DynamicRouteElement): string[] {
  return Object.keys(element.outputs ?? {}).sort(
    (a, b) => percentValue(b) - percentValue(a) || a.localeCompare(b),
  );
}

export function outputLabel(type: DynamicRouteElementType, name: string): string {
  if (type === "percentage") return name;
  switch (name) {
    case "next":
      return "다음";
    case "true":
      return "참";
    case "false":
      return "거짓";
    case "success":
      return type === "rate" ? "한도 안" : "성공";
    case "fallback":
      return type === "rate" ? "한도 초과" : "실패 시";
    default:
      return name;
  }
}

export function isRequiredOutput(type: DynamicRouteElementType, name: string): boolean {
  if (type === "start") return name === "next";
  if (type === "conditional") return true;
  if (type === "rate") return name === "success";
  return false;
}

const operatorLabels: Readonly<Record<string, string>> = {
  $eq: "=",
  $ne: "≠",
  $in: "∈",
  $nin: "∉",
  $gt: ">",
  $gte: "≥",
  $lt: "<",
  $lte: "≤",
};

function formatValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (Array.isArray(value)) return `[${value.map(formatValue).join(", ")}]`;
  return String(value);
}

/** A readable one-line rendering of a condition document. */
export function conditionSummary(conditions: unknown): string {
  if (typeof conditions !== "object" || conditions === null || Array.isArray(conditions)) return "조건 없음";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(conditions as Record<string, unknown>)) {
    if (key === "$and" || key === "$or") {
      const children = Array.isArray(value) ? value.map((child) => conditionSummary(child)) : [];
      parts.push(`(${children.join(key === "$and" ? " 그리고 " : " 또는 ")})`);
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (const [op, operand] of Object.entries(value as Record<string, unknown>)) {
        if (op === "$exists") parts.push(`${key} ${operand === true ? "있음" : "없음"}`);
        else parts.push(`${key} ${operatorLabels[op] ?? op} ${formatValue(operand)}`);
      }
      continue;
    }
    parts.push(`${key} = ${formatValue(value)}`);
  }
  return parts.length > 0 ? parts.join(" 그리고 ") : "조건 없음";
}

export function formatWindow(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "기간 미정";
  if (seconds % 86400 === 0) return `${seconds / 86400}일`;
  if (seconds % 3600 === 0) return `${seconds / 3600}시간`;
  if (seconds % 60 === 0) return `${seconds / 60}분`;
  return `${seconds}초`;
}

/** The short description shown on an element's card. */
export function describeElement(element: DynamicRouteElement): string {
  const props = element.properties;
  switch (element.type) {
    case "start":
      return "요청 진입점";
    case "end":
      return "응답 반환";
    case "conditional":
      return conditionSummary(props.conditions);
    case "percentage": {
      const keys = percentKeys(element);
      const split = keys.length > 0 ? keys.join(" / ") : "분배 없음";
      return props.stickyKey ? `${split} · ${props.stickyKey} 고정` : split;
    }
    case "rate": {
      const amount =
        props.limitType === "cost"
          ? `${(props.limit ?? 0).toLocaleString("ko-KR")}원`
          : `${(props.limit ?? 0).toLocaleString("ko-KR")}회`;
      const scope = props.key ? `${props.key}별` : "전체 공유";
      return `${formatWindow(props.window)}당 ${amount} · ${scope}`;
    }
    case "model": {
      const parts = [props.model || "모델 미지정", props.provider || "공급자 자동"];
      if (props.retries) parts.push(`재시도 ${props.retries}회`);
      if (props.timeout) parts.push(`${(props.timeout / 1000).toLocaleString("ko-KR")}초`);
      return parts.join(" · ");
    }
  }
}

export function elementTitle(element: DynamicRouteElement): string {
  return element.label?.trim() || element.id;
}

// ---- layout ----

export interface FlowNode {
  element: DynamicRouteElement;
  column: number;
  row: number;
  reachable: boolean;
}

export interface FlowEdge {
  from: string;
  to: string;
  output: string;
}

export interface FlowLayout {
  nodes: FlowNode[];
  edges: FlowEdge[];
  columns: number;
  rows: number;
}

/**
 * Places each element in the column of its longest distance from start, so every
 * edge points right. Elements start cannot reach go in a trailing column, where
 * they are visibly set apart. A cycle (which the server rejects) cannot hang the
 * layout: depth is bounded by the element count.
 */
export function layoutGraph(graph: DynamicRouteGraph): FlowLayout {
  const byId = new Map(graph.elements.map((element) => [element.id, element]));
  const edges: FlowEdge[] = [];
  for (const element of graph.elements) {
    for (const output of outputNames(element)) {
      const target = element.outputs?.[output]?.elementId;
      if (target && byId.has(target)) edges.push({ from: element.id, to: target, output });
    }
  }
  const depth = new Map<string, number>();
  const start = graph.elements.find((element) => element.type === "start");
  const limit = graph.elements.length;
  if (start) {
    depth.set(start.id, 0);
    // Bellman-Ford style relaxation on a DAG: at most `limit` passes.
    for (let pass = 0; pass < limit; pass++) {
      let changed = false;
      for (const edge of edges) {
        const from = depth.get(edge.from);
        if (from === undefined) continue;
        const next = Math.min(from + 1, limit);
        if ((depth.get(edge.to) ?? -1) < next) {
          depth.set(edge.to, next);
          changed = true;
        }
      }
      if (!changed) break;
    }
  }
  // Rows follow the branches: an element's first output continues its row and
  // every other output opens a new one, so alternatives sit side by side instead
  // of on top of each other. Columns only grow along a row, so two elements never
  // share a cell.
  const row = new Map<string, number>();
  let nextRow = 0;
  const place = (id: string, at: number): void => {
    if (row.has(id) || !depth.has(id)) return;
    row.set(id, at);
    const element = byId.get(id);
    if (!element) return;
    outputNames(element).forEach((output, index) => {
      const target = element.outputs?.[output]?.elementId;
      if (!target || row.has(target) || !depth.has(target)) return;
      place(target, index === 0 ? at : ++nextRow);
    });
  };
  if (start) place(start.id, 0);
  const reachableColumns = Math.max(0, ...depth.values()) + 1;
  let orphanRow = 0;
  const nodes: FlowNode[] = [];
  for (const element of graph.elements) {
    const reachable = depth.has(element.id);
    const column = reachable ? (depth.get(element.id) ?? 0) : reachableColumns;
    const at = reachable ? (row.get(element.id) ?? 0) : orphanRow++;
    nodes.push({ element, column, row: at, reachable });
  }
  const columns = Math.max(1, ...nodes.map((node) => node.column + 1));
  const rows = Math.max(1, ...nodes.map((node) => node.row + 1));
  return { nodes, edges, columns, rows };
}

// ---- simulation path ----

export interface PathHighlight {
  elements: ReadonlySet<string>;
  edges: ReadonlySet<string>;
  outcomes: ReadonlyMap<string, string>;
}

export const edgeKey = (from: string, to: string): string => `${from}->${to}`;

export function pathHighlight(steps: readonly DynamicRouteStep[] | undefined): PathHighlight | undefined {
  if (!steps || steps.length === 0) return undefined;
  const elements = new Set<string>();
  const edges = new Set<string>();
  const outcomes = new Map<string, string>();
  steps.forEach((step, index) => {
    elements.add(step.id);
    outcomes.set(step.id, step.outcome);
    const next = steps[index + 1];
    if (next) edges.add(edgeKey(step.id, next.id));
  });
  return { elements, edges, outcomes };
}

export function outcomeLabel(outcome: string): string {
  switch (outcome) {
    case "success":
      return "성공";
    case "failed":
      return "실패";
    case "skipped":
      return "건너뜀";
    case "selected":
      return "선택";
    case "exceeded":
      return "한도 초과";
    case "true":
      return "참";
    case "false":
      return "거짓";
    case "next":
      return "다음";
    case "end":
      return "종료";
    case "rate_limited":
      return "한도로 거절";
    case "no_model":
      return "모델 없음";
    default:
      return outcome;
  }
}

// ---- immutable edits ----

function nextId(graph: DynamicRouteGraph, type: DynamicRouteElementType): string {
  const used = new Set(graph.elements.map((element) => element.id));
  for (let index = 1; ; index++) {
    const candidate = `${type}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

export function defaultProperties(type: DynamicRouteElementType): DynamicRouteElement["properties"] {
  switch (type) {
    case "conditional":
      return { conditions: { "metadata.plan": { $eq: "free" } } };
    case "rate":
      return { limitType: "count", limit: 100, window: 3600, key: "metadata.user_id" };
    case "model":
      return { model: "", provider: "" };
    default:
      return {};
  }
}

/**
 * Adds an element and, when from/output are given, connects that output to it.
 * Returns the new graph and the id it chose.
 */
export function addElement(
  graph: DynamicRouteGraph,
  type: DynamicRouteElementType,
  from?: { id: string; output: string },
): { graph: DynamicRouteGraph; id: string } {
  const id = nextId(graph, type);
  const element: DynamicRouteElement = { id, type, properties: defaultProperties(type) };
  if (type === "percentage") element.outputs = {};
  let elements = [...graph.elements, element];
  if (from)
    elements = elements.map((item) => (item.id === from.id ? connectOutput(item, from.output, id) : item));
  return { graph: { ...graph, elements }, id };
}

function connectOutput(
  element: DynamicRouteElement,
  output: string,
  target: string | undefined,
): DynamicRouteElement {
  const kept = Object.entries(element.outputs ?? {}).filter(([name]) => name !== output);
  const outputs = Object.fromEntries(target ? [...kept, [output, { elementId: target }]] : kept);
  return { ...element, outputs };
}

export function setOutput(
  graph: DynamicRouteGraph,
  id: string,
  output: string,
  target: string | undefined,
): DynamicRouteGraph {
  return {
    ...graph,
    elements: graph.elements.map((item) => (item.id === id ? connectOutput(item, output, target) : item)),
  };
}

/** Removes an element and every output that pointed at it. Start cannot be removed. */
export function removeElement(graph: DynamicRouteGraph, id: string): DynamicRouteGraph {
  return {
    ...graph,
    elements: graph.elements
      .filter((item) => item.id !== id || item.type === "start")
      .map((item) => {
        const outputs = Object.fromEntries(
          Object.entries(item.outputs ?? {}).filter(([, target]) => target.elementId !== id),
        );
        return { ...item, outputs };
      }),
  };
}

export function updateElement(
  graph: DynamicRouteGraph,
  id: string,
  update: (element: DynamicRouteElement) => DynamicRouteElement,
): DynamicRouteGraph {
  return { ...graph, elements: graph.elements.map((item) => (item.id === id ? update(item) : item)) };
}

/** Renames an element and rewires every output that referenced the old id. */
export function renameElement(graph: DynamicRouteGraph, id: string, next: string): DynamicRouteGraph {
  if (id === next || graph.elements.some((item) => item.id === next)) return graph;
  return {
    ...graph,
    elements: graph.elements.map((item) => {
      const outputs = Object.fromEntries(
        Object.entries(item.outputs ?? {}).map(([name, target]) => [
          name,
          target.elementId === id ? { elementId: next } : target,
        ]),
      );
      return { ...item, id: item.id === id ? next : item.id, outputs };
    }),
  };
}

/** Replaces a percentage element's split. Targets are kept by position. */
export function setPercentages(
  element: DynamicRouteElement,
  branches: ReadonlyArray<{ percent: number; target: string }>,
): DynamicRouteElement {
  const outputs: Record<string, { elementId: string }> = {};
  for (const branch of branches) {
    const key = `${branch.percent}%`;
    if (branch.target && !(key in outputs)) outputs[key] = { elementId: branch.target };
  }
  return { ...element, outputs };
}

export const elementIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
export const routeNamePattern = /^[a-z0-9][a-z0-9._-]{0,62}$/u;

// ---- templates ----

export interface RouteTemplate {
  id: string;
  title: string;
  description: string;
  graph: DynamicRouteGraph;
}

const model = (
  id: string,
  name: string,
  extra: Partial<DynamicRouteElement["properties"]> = {},
  fallback?: string,
): DynamicRouteElement => ({
  id,
  type: "model",
  properties: { model: name, ...extra },
  outputs: { success: { elementId: "end" }, ...(fallback ? { fallback: { elementId: fallback } } : {}) },
});
const start = (next: string): DynamicRouteElement => ({
  id: "start",
  type: "start",
  properties: {},
  outputs: { next: { elementId: next } },
});
const end: DynamicRouteElement = { id: "end", type: "end", properties: {} };

export const routeTemplates: readonly RouteTemplate[] = [
  {
    id: "fallback",
    title: "장애 대비 폴백",
    description: "기본 모델이 시간 초과·오류로 실패하면 다른 모델로 넘깁니다.",
    graph: {
      elements: [
        start("primary"),
        model("primary", "", { timeout: 30000, retries: 1 }, "backup"),
        model("backup", ""),
        end,
      ],
    },
  },
  {
    id: "split",
    title: "A/B 비율 분배",
    description: "트래픽을 90:10으로 나눠 새 모델을 시험합니다. 사용자별로 같은 갈래를 유지합니다.",
    graph: {
      elements: [
        start("split"),
        {
          id: "split",
          type: "percentage",
          properties: { stickyKey: "metadata.user_id" },
          outputs: { "90%": { elementId: "current" }, "10%": { elementId: "candidate" } },
        },
        model("current", ""),
        model("candidate", "", {}, "current"),
        end,
      ],
    },
  },
  {
    id: "plan",
    title: "요금제별 분기",
    description:
      "metadata.plan이 free면 경량 모델, 아니면 고성능 모델로 보내고 실패 시 경량 모델로 넘깁니다.",
    graph: {
      elements: [
        start("plan"),
        {
          id: "plan",
          type: "conditional",
          properties: { conditions: { "metadata.plan": { $eq: "free" } } },
          outputs: { true: { elementId: "light" }, false: { elementId: "premium" } },
        },
        model("premium", "", { retries: 1 }, "light"),
        model("light", ""),
        end,
      ],
    },
  },
  {
    id: "budget",
    title: "사용자별 비용 한도",
    description: "사용자마다 하루 비용 한도 안에서는 고성능 모델, 넘으면 경량 모델을 씁니다.",
    graph: {
      elements: [
        start("budget"),
        {
          id: "budget",
          type: "rate",
          properties: { limitType: "cost", key: "metadata.user_id", limit: 5000, window: 86400 },
          outputs: { success: { elementId: "premium" }, fallback: { elementId: "light" } },
        },
        model("premium", "", {}, "light"),
        model("light", ""),
        end,
      ],
    },
  },
  {
    id: "single",
    title: "빈 경로",
    description: "시작 → 모델 → 종료만 있는 가장 단순한 경로에서 시작합니다.",
    graph: { elements: [start("model-1"), model("model-1", ""), end] },
  },
];

/** Fills empty model names in a template with the chosen defaults. */
export function applyTemplateModels(
  graph: DynamicRouteGraph,
  primary: string,
  secondary: string,
): DynamicRouteGraph {
  let seen = 0;
  return {
    ...graph,
    elements: graph.elements.map((element) => {
      if (element.type !== "model" || element.properties.model) return element;
      const name = seen === 0 ? primary : secondary || primary;
      seen++;
      return { ...element, properties: { ...element.properties, model: name } };
    }),
  };
}

export function parseGraphText(text: string): { graph?: DynamicRouteGraph; error?: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "JSON 형식이 아닙니다. 괄호와 따옴표를 확인하세요." };
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { elements?: unknown }).elements)
  ) {
    return {
      error:
        "elements 배열이 있는 객체여야 합니다. Cloudflare에서 내보낸 경로 JSON도 그대로 붙여 넣을 수 있습니다.",
    };
  }
  const elements = (value as { elements: unknown[] }).elements;
  for (const element of elements) {
    if (
      typeof element !== "object" ||
      element === null ||
      typeof (element as { id?: unknown }).id !== "string"
    ) {
      return { error: "모든 요소에 문자열 id가 있어야 합니다." };
    }
  }
  return { graph: value as DynamicRouteGraph };
}

export function graphText(graph: DynamicRouteGraph): string {
  return JSON.stringify({ elements: graph.elements }, null, 2);
}

export function sameGraph(a: DynamicRouteGraph | undefined, b: DynamicRouteGraph | undefined): boolean {
  return JSON.stringify(a?.elements ?? []) === JSON.stringify(b?.elements ?? []);
}

export function callSnippet(callModel: string, gatewayOrigin: string): string {
  return [
    `curl ${gatewayOrigin}/v1/chat/completions \\`,
    `  -H "Authorization: Bearer $VIBE_API_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H 'X-Vibe-Metadata: {"plan":"free","user_id":"u-123"}' \\`,
    `  -d '{"model":"${callModel}","messages":[{"role":"user","content":"안녕하세요"}]}'`,
  ].join("\n");
}

export function sdkSnippet(callModel: string, gatewayOrigin: string): string {
  return [
    "from openai import OpenAI",
    "",
    `client = OpenAI(base_url="${gatewayOrigin}/v1", api_key=VIBE_API_KEY)`,
    "reply = client.chat.completions.create(",
    `    model="${callModel}",`,
    '    messages=[{"role": "user", "content": "안녕하세요"}],',
    '    extra_headers={"X-Vibe-Metadata": \'{"plan": "free", "user_id": "u-123"}\'},',
    ")",
  ].join("\n");
}
