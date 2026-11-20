import { exactLegacySkillName, validSkillReference } from "./skill-identity";
import { z } from "zod";

import {
  skillFitnessSchema,
  type SkillFitness,
  type SkillFitnessBody,
} from "@/shared/api/domains/agents.schemas";

export const fitnessKinds = ["multimodel", "golden", "testcase"] as const;
export const fitnessKindLabels: Record<(typeof fitnessKinds)[number], string> = {
  multimodel: "여러 모델 비교",
  golden: "기준 답안 세트",
  testcase: "테스트 사례",
};
export const fitnessKindLabel = (kind: string): string =>
  Object.hasOwn(fitnessKindLabels, kind)
    ? fitnessKindLabels[kind as keyof typeof fitnessKindLabels]
    : `기타 근거 (${kind || "종류 미지정"})`;

// Existing Go handlers trim targets. Do not retarget imported/ambiguous names:
// JS trim also strips FEFF, while Go additionally strips edge NEL (U+0085).
export const exactFitnessSkillName = (name: unknown): name is string =>
  typeof name === "string" && exactLegacySkillName(name);
export const validFitnessTarget = (name: unknown, reference?: string): name is string =>
  reference !== undefined
    ? typeof name === "string" && name !== "" && validSkillReference(reference)
    : exactFitnessSkillName(name);

export const fitnessKey = (name: string, epoch: number, reference?: string) =>
  reference !== undefined
    ? (["agents", "skills", "reference", reference, "fitness", epoch] as const)
    : (["agents", "skills", name, "fitness", epoch] as const);
interface FitnessQueryState {
  status: "pending" | "error" | "success";
  fetchStatus: "fetching" | "paused" | "idle";
  isInvalidated?: boolean;
  data?: unknown;
}
export function confirmedFitness(
  state: FitnessQueryState | undefined,
  name: string,
  reference?: string,
): SkillFitness | undefined {
  if (
    !validFitnessTarget(name, reference) ||
    !state ||
    state.status !== "success" ||
    state.fetchStatus !== "idle" ||
    state.isInvalidated
  )
    return undefined;
  const parsed = skillFitnessSchema.safeParse(state.data);
  if (
    !parsed.success ||
    parsed.data.skill !== name ||
    (reference !== undefined && parsed.data.skill_ref !== reference) ||
    parsed.data.evidence.some((row) => row.skill_name !== name) ||
    parsed.data.passing_count !== parsed.data.evidence.filter((row) => row.passed).length
  )
    return undefined;
  return parsed.data;
}

export const fitnessFormSchema = z.object({
  kind: z.enum(fitnessKinds),
  // Require a reference after the server's Go White_Space trim, without
  // transforming opaque input (notably FEFF, which Go preserves).
  ref_id: z
    .string()
    .refine((value) => /[^\p{White_Space}]/u.test(value), "근거가 되는 실행·세트 ID를 입력하세요."),
  passed: z.boolean(),
  score: z
    .string()
    .trim()
    .refine((value) => value === "" || Number.isFinite(Number(value)), "유한한 숫자를 입력하세요."),
  note: z.string().trim().max(500, "메모는 500자까지 입력할 수 있습니다."),
});
export type FitnessFormValues = z.infer<typeof fitnessFormSchema>;
export const emptyFitnessForm: FitnessFormValues = {
  kind: "multimodel",
  ref_id: "",
  passed: true,
  score: "",
  note: "",
};
export function fitnessBody(
  name: string,
  input: FitnessFormValues,
  reference?: string,
): Readonly<SkillFitnessBody> {
  if (!validFitnessTarget(name, reference)) throw new Error("스킬 식별자를 변경 없이 확인할 수 없습니다.");
  const values = fitnessFormSchema.parse(input);
  return Object.freeze({
    ...values,
    ...(reference ? { skill_ref: reference } : { skill: name }),
    score: values.score === "" ? 0 : Number(values.score),
  });
}
