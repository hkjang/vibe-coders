import { describe, expect, it } from "vitest";

import {
  addStep,
  moveStep,
  parseSteps,
  removeStep,
  serializeSteps,
  unmodelledFields,
  updateStep,
  type StepDraft,
} from "@/features/agents/workflows/workflow-steps";

const steps: StepDraft[] = [
  { name: "정리", type: "transform" },
  { name: "초안", type: "chat", ref: "vibe/auto", max_tokens: 800 },
  { name: "승인", type: "approval" },
];

describe("parseSteps", () => {
  it("reads the JSON the form holds", () => {
    expect(parseSteps(serializeSteps(steps))).toEqual(steps);
  });

  it("answers with no steps rather than throwing on unusable input", () => {
    expect(parseSteps("not json")).toEqual([]);
    expect(parseSteps('{"steps":[]}')).toEqual([]);
    expect(parseSteps("[1, null, 2]")).toEqual([]);
  });

  it("gives a step with no declared type something editable", () => {
    expect(parseSteps('[{"name":"x"}]')).toEqual([{ name: "x", type: "chat" }]);
  });
});

describe("moveStep", () => {
  it("moves a step one place in execution order", () => {
    expect(moveStep(steps, 2, -1).map((step) => step.name)).toEqual(["정리", "승인", "초안"]);
    expect(moveStep(steps, 0, 1).map((step) => step.name)).toEqual(["초안", "정리", "승인"]);
  });

  it("refuses to move a step off either end", () => {
    expect(moveStep(steps, 0, -1)).toEqual(steps);
    expect(moveStep(steps, 2, 1)).toEqual(steps);
  });
});

describe("addStep / removeStep", () => {
  it("appends at the end and removes by position", () => {
    expect(addStep(steps, "skill").at(-1)).toEqual({ name: "", type: "skill" });
    expect(removeStep(steps, 1).map((step) => step.name)).toEqual(["정리", "승인"]);
  });
});

describe("updateStep", () => {
  it("clears an emptied limit instead of storing a zero the server would enforce", () => {
    const withLimit = updateStep(steps, 1, "max_tokens", "1200");
    expect(withLimit[1]).toMatchObject({ max_tokens: 1200 });
    expect(updateStep(withLimit, 1, "max_tokens", "")[1]).not.toHaveProperty("max_tokens");
    expect(updateStep(withLimit, 1, "max_tokens", "-5")[1]).not.toHaveProperty("max_tokens");
  });

  it("splits a comma list and drops it when emptied", () => {
    const tools = updateStep(steps, 1, "allowed_tools", " search , fetch ");
    expect(tools[1]).toMatchObject({ allowed_tools: ["search", "fetch"] });
    expect(updateStep(tools, 1, "allowed_tools", "")[1]).not.toHaveProperty("allowed_tools");
  });

  it("drops the fields a new step type does not use, so nothing travels unseen", () => {
    const changed = updateStep(steps, 1, "type", "approval");
    expect(changed[1]).toEqual({ name: "초안", type: "approval" });
  });

  it("keeps fields this build does not model when another field is edited", () => {
    const exotic: StepDraft[] = [{ name: "x", type: "chat", retry_policy: { attempts: 3 } }];
    const edited = updateStep(exotic, 0, "name", "y");
    expect(edited[0]).toEqual({ name: "y", type: "chat", retry_policy: { attempts: 3 } });
    expect(unmodelledFields(edited[0] as StepDraft)).toEqual(["retry_policy"]);
  });

  it("leaves the other steps untouched", () => {
    expect(updateStep(steps, 0, "name", "정리됨")[2]).toBe(steps[2]);
  });
});
