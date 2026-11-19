import { type Skill } from "@/shared/api/domains/agents.schemas";
import { containsPotentialSecret } from "@/shared/security/secrets";

export { isSkillRef as validSkillReference } from "@/shared/api/skill-ref";
import { isSkillRef as validSkillReference } from "@/shared/api/skill-ref";
export const skillReference = (skill: Pick<Skill, "skill_ref"> | undefined): string | undefined =>
  validSkillReference(skill?.skill_ref) ? skill.skill_ref : undefined;

export function safeSkillNameForURL(name: string, prefixes: readonly string[]): boolean {
  return (
    name !== "" &&
    new TextEncoder().encode(name).length <= 4096 &&
    !/[\\\p{C}]/u.test(name) &&
    !containsPotentialSecret(name, prefixes)
  );
}
export const skillIdentityKey = (skill: Pick<Skill, "name" | "skill_ref">): string =>
  skillReference(skill) ? "ref:" + skillReference(skill) : "name:" + skill.name;
export const exactLegacySkillName = (name: string): boolean =>
  name !== "" && name.trim() === name && !/^\u0085|\u0085$/u.test(name);
function assertLegacySelector(skill: Pick<Skill, "name" | "skill_ref">): void {
  if (skill.skill_ref !== undefined || !exactLegacySkillName(skill.name))
    throw new Error("선택한 스킬을 정확히 처리하려면 서버의 스킬 식별자 지원이 필요합니다.");
}
export const skillNameSelector = (skill: Pick<Skill, "name" | "skill_ref">) => {
  const ref = skillReference(skill);
  if (ref) return { skill_ref: ref };
  assertLegacySelector(skill);
  return { name: skill.name };
};
export const skillQuerySelector = (skill: Pick<Skill, "name" | "skill_ref">) => {
  const ref = skillReference(skill);
  if (ref) return { skill_ref: ref };
  assertLegacySelector(skill);
  return { skill: skill.name };
};
export function skillSelection(skill: Pick<Skill, "name" | "skill_ref">, prefixes: readonly string[]) {
  const ref = skillReference(skill);
  return {
    skill_ref: ref,
    skill:
      skill.skill_ref === undefined && !ref && safeSkillNameForURL(skill.name, prefixes)
        ? skill.name
        : undefined,
  };
}
