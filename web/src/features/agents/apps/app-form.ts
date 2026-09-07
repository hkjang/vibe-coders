import { z } from "zod";

import type { AppOnboardingBody, WorkApp, WorkAppWriteBody } from "@/shared/api/domains/agents.schemas";

/** Component kinds `validateAppComponent` resolves (internal/proxy/admin_work_apps.go). */
export const appComponentKinds = ["skill", "prompt_product", "text2sql_report", "mcp_tool", "model"] as const;

export const appComponentKindLabels: Record<(typeof appComponentKinds)[number], string> = {
  skill: "Skill",
  prompt_product: "프롬프트 상품",
  text2sql_report: "Text2SQL 저장 리포트",
  mcp_tool: "MCP 도구",
  model: "추천 모델",
};

export const appStatusOptions = [
  { value: "active", label: "활성" },
  { value: "archived", label: "보관" },
];

const componentSchema = z.object({
  kind: z.string(),
  ref: z.string().optional(),
  label: z.string().optional(),
});

export const appComponentsExample = JSON.stringify(
  [
    { kind: "skill", ref: "code-review", label: "코드 리뷰 Skill" },
    { kind: "model", ref: "", label: "추천 모델(코딩 품질 상위)" },
  ],
  null,
  2,
);

export const appFormSchema = z
  .object({
    title: z.string().trim().min(1, "앱 제목을 입력하세요."),
    description: z.string(),
    icon: z.string(),
    allowed_teams: z.string(),
    allowed_roles: z.string(),
    status: z.string(),
    components: z.string(),
  })
  .superRefine((values, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(values.components) as unknown;
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["components"],
        message: "구성 요소가 올바른 JSON이 아닙니다.",
      });
      return;
    }
    const result = z.array(componentSchema).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: "custom",
        path: ["components"],
        message: "구성 요소는 kind/ref/label을 가진 객체 배열이어야 합니다.",
      });
      return;
    }
    const allowed = new Set<string>(appComponentKinds);
    const invalid = result.data.find((component) => !allowed.has(component.kind.trim()));
    if (invalid) {
      ctx.addIssue({
        code: "custom",
        path: ["components"],
        message: `허용되지 않는 구성 요소 종류입니다: ${invalid.kind}. 사용 가능: ${appComponentKinds.join(", ")}`,
      });
    }
  })
  .transform((values) => ({
    title: values.title.trim(),
    description: values.description.trim(),
    icon: values.icon.trim(),
    allowed_teams: values.allowed_teams.trim(),
    allowed_roles: values.allowed_roles.trim(),
    status: values.status,
    components: z
      .array(componentSchema)
      .parse(JSON.parse(values.components))
      .map((component) => ({
        kind: component.kind.trim(),
        ref: component.ref?.trim() ?? "",
        label: component.label?.trim() ?? "",
      })),
  }));

export type AppFormInput = z.input<typeof appFormSchema>;
export type AppFormOutput = z.output<typeof appFormSchema>;

export function appFormDefaults(app?: WorkApp): AppFormInput {
  return {
    title: app?.title ?? "",
    description: app?.description ?? "",
    icon: app?.icon ?? "",
    allowed_teams: app?.allowed_teams ?? "",
    allowed_roles: app?.allowed_roles ?? "",
    status: app?.status ?? "active",
    components: JSON.stringify(app?.components ?? [], null, 2),
  };
}

export function appWriteBody(values: AppFormOutput): WorkAppWriteBody {
  return {
    title: values.title,
    description: values.description,
    icon: values.icon,
    allowed_teams: values.allowed_teams,
    allowed_roles: values.allowed_roles,
    status: values.status,
    components: values.components,
  };
}

export function appOnboardingBody(values: AppFormOutput, owner: string): AppOnboardingBody {
  return {
    title: values.title,
    description: values.description,
    owner,
    allowed_teams: values.allowed_teams,
    allowed_roles: values.allowed_roles,
    components: values.components,
  };
}

export function matchesAppQuery(app: WorkApp, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [app.title, app.description, app.owner, app.allowed_teams, app.allowed_roles, app.id].some((value) =>
    (value ?? "").toLowerCase().includes(needle),
  );
}
