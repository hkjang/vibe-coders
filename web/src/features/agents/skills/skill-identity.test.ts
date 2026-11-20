import { describe, expect, it } from "vitest";
import { skillFormDefaults, skillFormSchemaFor, skillWriteBody } from "./skill-form";
import {
  skillIdentityKey,
  skillNameSelector,
  skillQuerySelector,
  skillSelection,
  validSkillReference,
} from "./skill-identity";
import { confirmedFitness, emptyFitnessForm, fitnessBody, fitnessKey } from "./skill-fitness-state";
const reference = "skl_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
describe("exact skill reference identity", () => {
  it.each(["a".repeat(4097), "corp_" + "x".repeat(43), " exact ", "/a/../b/", "\u0085name\u0085"])(
    "keeps full stored identity out of address and API selectors",
    (name) => {
      const skill = { name, skill_ref: reference };
      expect(skillSelection(skill, ["corp_"])).toEqual({ skill: undefined, skill_ref: reference });
      expect(skillNameSelector(skill)).toEqual({ skill_ref: reference });
      expect(skillQuerySelector(skill)).toEqual({ skill_ref: reference });
      expect(fitnessBody(name, { ...emptyFitnessForm, ref_id: "proof" }, reference)).toMatchObject({
        skill_ref: reference,
      });
      expect(fitnessBody(name, { ...emptyFitnessForm, ref_id: "proof" }, reference).skill).toBeUndefined();
      expect(fitnessKey(name, 1, reference)).not.toContain(name);
    },
  );
  it("does not turn an invalid reference into a legacy name selector", () => {
    for (const invalid of ["", reference + "=", "skl_" + "A".repeat(42) + "B"]) {
      expect(validSkillReference(invalid)).toBe(false);
      expect(() => skillNameSelector({ name: "safe", skill_ref: invalid })).toThrow();
      expect(() => fitnessBody("safe", { ...emptyFitnessForm, ref_id: "proof" }, invalid)).toThrow();
    }
  });
  it("keeps reference and literal display collisions separate", () => {
    expect(skillIdentityKey({ name: "name", skill_ref: reference })).not.toBe(
      skillIdentityKey({ name: "ref:" + reference }),
    );
    expect(skillSelection({ name: "corp_" + "x".repeat(43) }, ["corp_"])).toEqual({
      skill: undefined,
      skill_ref: undefined,
    });
  });
  it("edits imported names without creation-time normalization or metadata loss", () => {
    const skill = {
      name: " /Imported Skill/ ",
      skill_ref: reference,
      description: " description ",
      version: " v1 ",
      owner: " owner ",
      allowed_models: " model ",
      allowed_tools: " tool ",
      allowed_teams: " team ",
      metadata: '{"nested":{"value":"keep"}}',
      daily_limit: -1,
    };
    const values = skillFormSchemaFor(skill).parse(skillFormDefaults(skill));
    for (const key of [
      "name",
      "description",
      "version",
      "owner",
      "allowed_models",
      "allowed_tools",
      "allowed_teams",
    ] as const)
      expect(values[key]).toBe(skill[key]);
    expect(values.daily_limit).toBe(-1);
    const body = skillWriteBody(values, skill);
    expect(body.skill_ref).toBe(reference);
    expect(body.metadata).toBeUndefined();
    expect(() => skillFormSchemaFor(skill).parse({ ...skillFormDefaults(skill), name: "renamed" })).toThrow();
    const legacy = { name: "safe", metadata: skill.metadata };
    expect(
      skillWriteBody(skillFormSchemaFor(legacy).parse(skillFormDefaults(legacy)), legacy).metadata,
    ).toEqual({ nested: { value: "keep" } });
  });
  it("requires both exact name and reference when confirming fitness", () => {
    const name = " exact ";
    const data = { skill: name, skill_ref: reference, evidence: [], passing_count: 0, required: 2 };
    const state = { status: "success", fetchStatus: "idle", data } as const;
    expect(confirmedFitness(state, name, reference)).toEqual(data);
    expect(
      confirmedFitness({ ...state, data: { ...data, skill_ref: undefined } }, name, reference),
    ).toBeUndefined();
    expect(
      confirmedFitness({ ...state, data: { ...data, skill: "exact" } }, name, reference),
    ).toBeUndefined();
  });
});
