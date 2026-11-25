import { describe, expect, it } from "vitest";

import type { DynamicRouteGraph } from "@/shared/api/domains/routing-dynamic";

import { buildConditions, parseSimpleConditions, ruleError } from "./dynamic-route-conditions";
import {
  addElement,
  applyTemplateModels,
  conditionSummary,
  describeElement,
  layoutGraph,
  parseGraphText,
  pathHighlight,
  removeElement,
  renameElement,
  routeTemplates,
  setOutput,
  setPercentages,
} from "./dynamic-route-model";

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("expected a value");
  return value;
}

const graph: DynamicRouteGraph = {
  elements: [
    { id: "start", type: "start", properties: {}, outputs: { next: { elementId: "plan" } } },
    {
      id: "plan",
      type: "conditional",
      properties: { conditions: { "metadata.plan": { $eq: "free" } } },
      outputs: { true: { elementId: "cheap" }, false: { elementId: "premium" } },
    },
    {
      id: "premium",
      type: "model",
      properties: { model: "big", provider: "openai", retries: 2, timeout: 30000 },
      outputs: { success: { elementId: "end" }, fallback: { elementId: "cheap" } },
    },
    {
      id: "cheap",
      type: "model",
      properties: { model: "small" },
      outputs: { success: { elementId: "end" } },
    },
    { id: "end", type: "end", properties: {} },
    { id: "orphan", type: "model", properties: { model: "lonely" } },
  ],
};

describe("layoutGraph", () => {
  it("puts every element right of what leads to it and sets unreachable ones apart", () => {
    const layout = layoutGraph(graph);
    const column = (id: string) => layout.nodes.find((node) => node.element.id === id)?.column;
    expect(column("start")).toBe(0);
    expect(column("plan")).toBe(1);
    expect(column("premium")).toBe(2);
    // cheap is reached from plan (depth 2) and from premium's fallback (depth 3): the longer wins.
    expect(column("cheap")).toBe(3);
    expect(column("end")).toBe(4);
    const orphan = layout.nodes.find((node) => node.element.id === "orphan");
    expect(orphan?.reachable).toBe(false);
    expect(orphan?.column).toBe(5);
    for (const edge of layout.edges) expect(column(edge.to)).toBeGreaterThan(column(edge.from) ?? -1);
  });

  it("does not hang on a cycle the server would reject", () => {
    const cyclic: DynamicRouteGraph = {
      elements: [
        { id: "start", type: "start", properties: {}, outputs: { next: { elementId: "a" } } },
        { id: "a", type: "model", properties: { model: "x" }, outputs: { fallback: { elementId: "b" } } },
        { id: "b", type: "model", properties: { model: "y" }, outputs: { fallback: { elementId: "a" } } },
      ],
    };
    expect(layoutGraph(cyclic).nodes).toHaveLength(3);
  });
});

describe("graph edits", () => {
  it("adds an element connected to the chosen output with a fresh id", () => {
    const added = addElement(graph, "model", { id: "cheap", output: "fallback" });
    expect(added.id).toBe("model-1");
    expect(added.graph.elements.find((element) => element.id === "cheap")?.outputs?.fallback).toEqual({
      elementId: "model-1",
    });
    expect(addElement(added.graph, "model").id).toBe("model-2");
  });

  it("removes an element and every connection to it, but never start", () => {
    const removed = removeElement(graph, "cheap");
    expect(removed.elements.some((element) => element.id === "cheap")).toBe(false);
    expect(removed.elements.find((element) => element.id === "plan")?.outputs?.true).toBeUndefined();
    expect(removed.elements.find((element) => element.id === "premium")?.outputs?.fallback).toBeUndefined();
    expect(removeElement(graph, "start").elements.some((element) => element.id === "start")).toBe(true);
  });

  it("renames and rewires references, refusing a taken id", () => {
    const renamed = renameElement(graph, "cheap", "light");
    expect(renamed.elements.find((element) => element.id === "plan")?.outputs?.true).toEqual({
      elementId: "light",
    });
    expect(renameElement(graph, "cheap", "premium")).toBe(graph);
  });

  it("connects and disconnects outputs", () => {
    const cleared = setOutput(graph, "premium", "fallback", undefined);
    expect(cleared.elements.find((element) => element.id === "premium")?.outputs).toEqual({
      success: { elementId: "end" },
    });
  });

  it("writes a percentage split as Cloudflare-style keyed outputs", () => {
    const split = setPercentages({ id: "p", type: "percentage", properties: {} }, [
      { percent: 70, target: "a" },
      { percent: 30, target: "b" },
      { percent: 30, target: "c" },
    ]);
    expect(split.outputs).toEqual({ "70%": { elementId: "a" }, "30%": { elementId: "b" } });
  });
});

describe("descriptions", () => {
  it("summarizes conditions and elements in plain language", () => {
    expect(conditionSummary({ "metadata.plan": { $eq: "free" }, "identity.team": "ml" })).toBe(
      'metadata.plan = "free" 그리고 identity.team = "ml"',
    );
    expect(
      conditionSummary({ $or: [{ "metadata.tier": { $gte: 3 } }, { "metadata.beta": { $exists: true } }] }),
    ).toBe("(metadata.tier ≥ 3 또는 metadata.beta 있음)");
    expect(describeElement(must(graph.elements[2]))).toBe("big · openai · 재시도 2회 · 30초");
    expect(
      describeElement({
        id: "r",
        type: "rate",
        properties: { limitType: "cost", limit: 5000, window: 86400, key: "metadata.user_id" },
      }),
    ).toBe("1일당 5,000원 · metadata.user_id별");
  });
});

describe("templates", () => {
  it("fills empty model names, primary first", () => {
    const fallback = routeTemplates.find((template) => template.id === "fallback");
    const filled = applyTemplateModels(must(fallback).graph, "gpt-4.1", "gpt-4.1-mini");
    const models = filled.elements
      .filter((element) => element.type === "model")
      .map((element) => element.properties.model);
    expect(models).toEqual(["gpt-4.1", "gpt-4.1-mini"]);
  });
});

describe("parseGraphText", () => {
  it("accepts a Cloudflare export and explains what is wrong otherwise", () => {
    expect(
      parseGraphText('{"id":"1","name":"x","elements":[{"id":"start","type":"start"}]}').graph?.elements,
    ).toHaveLength(1);
    expect(parseGraphText("{").error).toContain("JSON");
    expect(parseGraphText('{"nodes":[]}').error).toContain("elements");
    expect(parseGraphText('{"elements":[{"type":"start"}]}').error).toContain("id");
  });
});

describe("pathHighlight", () => {
  it("marks visited elements, the edges between them and each outcome", () => {
    const highlight = pathHighlight([
      { id: "start", type: "start", outcome: "next" },
      { id: "premium", type: "model", outcome: "failed" },
      { id: "cheap", type: "model", outcome: "success" },
    ]);
    expect(highlight?.edges.has("premium->cheap")).toBe(true);
    expect(highlight?.outcomes.get("premium")).toBe("failed");
    expect(pathHighlight([])).toBeUndefined();
  });
});

describe("condition builder", () => {
  it("round-trips the shapes it can edit", () => {
    const all = { "metadata.plan": { $in: ["free", "trial"] }, "metadata.tier": { $gte: 3 } };
    const parsed = parseSimpleConditions(all);
    expect(parsed?.mode).toBe("all");
    expect(buildConditions(must(parsed))).toEqual(all);
    const any = { $or: [{ "identity.team": { $eq: "ml" } }, { "metadata.beta": { $eq: true } }] };
    expect(buildConditions(must(parseSimpleConditions(any)))).toEqual(any);
  });

  it("hands nested logic to the JSON editor", () => {
    expect(parseSimpleConditions({ $or: [{ $and: [{ "metadata.a": 1 }] }] })).toBeUndefined();
    expect(parseSimpleConditions({ "metadata.a": { $regex: "x" } })).toBeUndefined();
  });

  it("checks rows before they are sent and leaves bad rows out", () => {
    expect(ruleError({ field: "body.model", op: "$eq", value: "x", valueType: "string" })).toContain("필드");
    expect(ruleError({ field: "metadata.tier", op: "$gt", value: "abc", valueType: "number" })).toContain(
      "숫자",
    );
    expect(ruleError({ field: "metadata.beta", op: "$eq", value: "yes", valueType: "boolean" })).toContain(
      "true",
    );
    expect(
      buildConditions({
        mode: "all",
        rules: [
          { field: "metadata.plan", op: "$eq", value: "free", valueType: "string" },
          { field: "metadata.", op: "$eq", value: "", valueType: "string" },
        ],
      }),
    ).toEqual({ "metadata.plan": { $eq: "free" } });
  });
});
