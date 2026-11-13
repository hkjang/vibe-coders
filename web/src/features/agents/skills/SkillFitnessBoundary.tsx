import { useContext, type ReactNode } from "react";

import { SkillFitnessContext } from "./skill-fitness-context";
import { useSkillFitnessEditor } from "./use-skill-fitness-editor";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { SkillScopeBoundary } from "./skill-scope";

export function SkillFitnessBoundary({ children }: { children: ReactNode }): React.JSX.Element {
  const inherited = useContext(SkillFitnessContext);
  if (inherited) return <>{children}</>;
  return (
    <SkillScopeBoundary>
      <DraftOwner>{children}</DraftOwner>
    </SkillScopeBoundary>
  );
}
function DraftOwner({ children }: { children: ReactNode }) {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <Owner>{children}</Owner>
  ) : (
    <UnsavedChangesProvider>
      <Owner>{children}</Owner>
    </UnsavedChangesProvider>
  );
}
function Owner({ children }: { children: ReactNode }): React.JSX.Element {
  const editor = useSkillFitnessEditor();
  return <SkillFitnessContext.Provider value={editor}>{children}</SkillFitnessContext.Provider>;
}
