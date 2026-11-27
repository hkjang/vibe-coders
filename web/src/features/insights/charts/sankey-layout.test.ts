import { describe, expect, it } from "vitest";

import { sankeyLayout, type SankeyFrame } from "./sankey-layout";

const frame: SankeyFrame = {
  width: 520,
  height: 220,
  padding: { top: 10, right: 10, bottom: 10, left: 10 },
  nodeWidth: 10,
  nodeGap: 10,
  columns: ["team", "category", "model"],
};

const nodes = [
  { id: "team:a", kind: "team", name: "플랫폼팀", value: 60 },
  { id: "team:b", kind: "team", name: "데이터팀", value: 40 },
  { id: "cat:dev", kind: "category", name: "소프트웨어 개발", value: 70 },
  { id: "cat:data", kind: "category", name: "데이터 분석", value: 30 },
  { id: "model:x", kind: "model", name: "model-x", value: 100 },
];
const links = [
  { source: "team:a", target: "cat:dev", value: 50 },
  { source: "team:a", target: "cat:data", value: 10 },
  { source: "team:b", target: "cat:dev", value: 20 },
  { source: "team:b", target: "cat:data", value: 20 },
  { source: "cat:dev", target: "model:x", value: 70 },
  { source: "cat:data", target: "model:x", value: 30 },
];

describe("sankeyLayout", () => {
  const layout = sankeyLayout(nodes, links, frame);
  const node = (id: string) => {
    const found = layout.nodes.find((item) => item.id === id);
    if (!found) throw new Error(`missing node ${id}`);
    return found;
  };

  it("puts each kind in its own column, left to right", () => {
    expect(node("team:a")).toMatchObject({ column: 0, x: 10 });
    expect(node("cat:dev")).toMatchObject({ column: 1, x: 255 });
    expect(node("model:x")).toMatchObject({ column: 2, x: 500 });
  });

  it("uses one scale so heights and ribbons are comparable across columns", () => {
    // Two nodes and one gap fit 100 units of flow into 200 - 10 = 190 user units.
    expect(layout.scale).toBeCloseTo(1.9);
    expect(node("team:a").height).toBeCloseTo(114);
    expect(node("team:b").height).toBeCloseTo(76);
    expect(node("model:x").height).toBeCloseTo(190);
    const ribbon = layout.links.find((link) => link.source === "team:a" && link.target === "cat:dev");
    expect(ribbon?.thickness).toBeCloseTo(95);
  });

  it("stacks nodes tallest first with a gap", () => {
    expect(node("team:a").y).toBe(10);
    expect(node("team:b").y).toBeCloseTo(10 + 114 + 10);
    expect(node("cat:dev").y).toBe(10);
    expect(node("cat:data").y).toBeCloseTo(10 + 133 + 10);
  });

  it("orders ribbons on each side by where their other end sits", () => {
    const find = (source: string, target: string) => {
      const found = layout.links.find((link) => link.source === source && link.target === target);
      if (!found) throw new Error("missing link");
      return found;
    };
    // Leaving team a: the ribbon to the upper category (dev) comes first.
    expect(find("team:a", "cat:dev").sourceY).toBe(10);
    expect(find("team:a", "cat:data").sourceY).toBeCloseTo(10 + 95);
    // Entering dev: the ribbon from the upper team (a) comes first.
    expect(find("team:a", "cat:dev").targetY).toBe(10);
    expect(find("team:b", "cat:dev").targetY).toBeCloseTo(10 + 95);
    for (const link of layout.links) {
      expect(link.path.startsWith("M")).toBe(true);
      expect(link.path).not.toContain("NaN");
    }
  });

  it("keeps every ribbon inside its node", () => {
    for (const item of layout.nodes) {
      const leaving = layout.links.filter((link) => link.source === item.id);
      const entering = layout.links.filter((link) => link.target === item.id);
      for (const link of leaving) {
        expect(link.sourceY).toBeGreaterThanOrEqual(item.y - 1e-6);
        expect(link.sourceY + link.thickness).toBeLessThanOrEqual(item.y + item.height + 1e-6);
      }
      for (const link of entering) {
        expect(link.targetY).toBeGreaterThanOrEqual(item.y - 1e-6);
        expect(link.targetY + link.thickness).toBeLessThanOrEqual(item.y + item.height + 1e-6);
      }
    }
  });

  it("drops links it cannot draw and nodes of an unknown kind", () => {
    const result = sankeyLayout(
      [...nodes, { id: "tool:z", kind: "tool", name: "도구", value: 9 }],
      [
        ...links,
        { source: "team:a", target: "missing", value: 5 },
        { source: "cat:dev", target: "team:a", value: 5 },
        { source: "team:a", target: "team:b", value: 5 },
        { source: "team:a", target: "tool:z", value: 5 },
        { source: "team:a", target: "cat:dev", value: 0 },
      ],
      frame,
    );
    expect(result.links).toHaveLength(links.length);
    expect(result.nodes.map((item) => item.id)).not.toContain("tool:z");
  });

  it("sizes a node without links by its own value and survives empty input", () => {
    const lone = sankeyLayout([{ id: "team:a", kind: "team", name: "팀", value: 5 }], [], frame);
    expect(lone.nodes[0]).toMatchObject({ throughput: 5, height: 200 });
    expect(sankeyLayout([], [], frame)).toEqual({ nodes: [], links: [], scale: 0 });
  });
});
