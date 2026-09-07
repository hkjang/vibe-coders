/** Asset kinds the SBOM handler emits, with the labels the legacy screen used. */
export const sbomTypeLabels: Record<string, string> = {
  skill: "스킬",
  workflow: "워크플로",
  app: "앱",
  model_contract: "모델 계약",
  prompt_asset: "프롬프트 자산",
};

export const sbomTypes = Object.keys(sbomTypeLabels);

export function isSbomType(value: string | null | undefined): boolean {
  return sbomTypes.includes(value ?? "");
}
