import { createContext, useContext } from "react";

import type { SkillFitnessEditor } from "./use-skill-fitness-editor";

export const SkillFitnessContext = createContext<SkillFitnessEditor | undefined>(undefined);
export function useSkillFitnessContext(): SkillFitnessEditor {
  const editor = useContext(SkillFitnessContext);
  if (!editor) throw new Error("Skill evidence requires a draft boundary");
  return editor;
}
