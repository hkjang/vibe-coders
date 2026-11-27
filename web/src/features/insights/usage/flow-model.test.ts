import { describe, expect, it } from "vitest";

import { categoryPaint } from "@/features/insights/charts/palette";

import { flowNodeKey, flowNodePaint, isFlowRest } from "./flow-model";

describe("flow nodes", () => {
  it("reads the filter key from a bare or a kind-prefixed ID", () => {
    expect(flowNodeKey({ id: "category:dev.codegen", kind: "category", name: "코드 생성" })).toBe(
      "dev.codegen",
    );
    expect(flowNodeKey({ id: "dev", kind: "category", name: "소프트웨어 개발" })).toBe("dev");
    expect(flowNodeKey({ id: "team:플랫폼팀", kind: "team", name: "플랫폼팀" })).toBe("플랫폼팀");
    expect(flowNodeKey({ id: "model:", kind: "model", name: "gpt-4.1" })).toBe("gpt-4.1");
  });

  it("colours only category nodes by their category", () => {
    expect(flowNodePaint({ id: "category:dev", kind: "category", name: "개발" })).toEqual(
      categoryPaint("dev"),
    );
    expect(flowNodePaint({ id: "team:a", kind: "team", name: "a" }).colorVar).toBe("--wi-cat-neutral");
    expect(flowNodePaint({ id: "model:m", kind: "model", name: "m" }).colorVar).toBe("--wi-cat-neutral");
  });

  it("treats each column's 기타 node as a remainder: neutral and not a filter", () => {
    const rest = { id: "category:기타", kind: "category", name: "기타" };
    expect(isFlowRest(rest)).toBe(true);
    expect(isFlowRest({ id: "team:기타", kind: "team", name: "기타" })).toBe(true);
    expect(isFlowRest({ id: "category:dev", kind: "category", name: "개발" })).toBe(false);
    expect(flowNodePaint(rest).colorVar).toBe("--wi-cat-neutral");
  });
});
