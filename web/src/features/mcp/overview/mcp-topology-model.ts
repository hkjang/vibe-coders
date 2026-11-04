import type { McpTopology, McpTopologyNode } from "@/shared/api/domains/mcp.schemas";

const kinds: Readonly<Record<string, string>> = {
  gateway: "게이트웨이",
  upstream: "업스트림",
  tool: "도구",
  prompt: "프롬프트",
  resource: "리소스",
};
const states: Readonly<Record<string, string>> = {
  enabled: "사용",
  disabled: "중지",
  allow: "허용",
  warn: "경고",
  block: "차단",
  approval_required: "승인 필요",
  require_approval: "승인 필요",
  not_in_allowlist: "허용목록 외",
};
export const topologyKind = (value: string) =>
  Object.hasOwn(kinds, value) ? (kinds[value] ?? value) : value;
export const topologyState = (value: string) =>
  Object.hasOwn(states, value) ? (states[value] ?? value) : value || "제공 안 됨";
export const topologyEdgeLabel = (value: string) =>
  value === "aggregates" ? "게이트웨이 통합" : value || "연결";
export const graphLimit = 60;

export function topologyModel(data: McpTopology) {
  const byId = new Map(data.nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, McpTopology["edges"]>();
  const outgoing = new Map<string, McpTopology["edges"]>();
  const missing = data.edges.filter((edge) => !byId.has(edge.from) || !byId.has(edge.to));
  for (const edge of data.edges) {
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    incoming.get(edge.to)?.push(edge);
    outgoing.get(edge.from)?.push(edge);
  }
  const reached = new Set<string>();
  const queue = data.nodes.filter((node) => node.kind === "gateway").map((node) => node.id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (id === undefined) continue;
    if (reached.has(id) || !byId.has(id)) continue;
    reached.add(id);
    for (const edge of outgoing.get(id) ?? []) if (!reached.has(edge.to)) queue.push(edge.to);
  }
  return {
    byId,
    incoming,
    outgoing,
    missing,
    disconnected: data.nodes.filter((node) => !reached.has(node.id)),
  };
}

export function filterTopology(nodes: McpTopologyNode[], search: string, kind: string, state: string) {
  const query = search.trim().toLocaleLowerCase();
  return nodes.filter(
    (node) =>
      (!kind || node.kind === kind) &&
      (!state || node.decision === state || node.status === state) &&
      (!query ||
        [
          node.label,
          node.id,
          topologyKind(node.kind),
          topologyState(node.status),
          topologyState(node.decision),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)),
  );
}

export function layoutTopology(nodes: McpTopologyNode[]) {
  const rows = [0, 0, 0, 0];
  const positions = nodes.slice(0, graphLimit).map((node) => {
    const column =
      node.kind === "gateway"
        ? 0
        : node.kind === "upstream"
          ? 1
          : ["tool", "prompt", "resource"].includes(node.kind)
            ? 2
            : 3;
    const row = rows[column] ?? 0;
    rows[column] = row + 1;
    return { node, x: 20 + column * 250, y: 32 + row * 116 };
  });
  return { positions, width: rows[3] ? 1020 : 770, height: Math.max(220, Math.max(...rows) * 116 + 50) };
}
