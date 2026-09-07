import type { EffectiveSetting } from "@/shared/api/domains/system.schemas";

export const consoleSettingPrefix = "ui.app.";
export const consoleFeaturePrefix = "ui.app.feature.";

export type ConsoleFeatureField = "status" | "roles" | "rollout" | "readonly";

export interface ConsoleFeatureKey {
  featureId: string;
  field: ConsoleFeatureField;
}

const consoleFeatureFields: readonly ConsoleFeatureField[] = ["status", "roles", "rollout", "readonly"];

/** `ui.app.feature.<feature id>.<field>` → its parts, or undefined for other keys. */
export function parseConsoleFeatureKey(key: string): ConsoleFeatureKey | undefined {
  if (!key.startsWith(consoleFeaturePrefix)) return undefined;
  const rest = key.slice(consoleFeaturePrefix.length);
  const separator = rest.lastIndexOf(".");
  if (separator <= 0) return undefined;
  const field = rest.slice(separator + 1);
  if (!(consoleFeatureFields as readonly string[]).includes(field)) return undefined;
  return { featureId: rest.slice(0, separator), field: field as ConsoleFeatureField };
}

export function isConsoleSetting(setting: EffectiveSetting): boolean {
  return setting.key.startsWith(consoleSettingPrefix);
}

export function settingCategories(settings: readonly EffectiveSetting[]): string[] {
  return [...new Set(settings.map((setting) => setting.category))].sort((left, right) =>
    left.localeCompare(right),
  );
}

export function filterSettings(
  settings: readonly EffectiveSetting[],
  options: { category?: string; query?: string },
): EffectiveSetting[] {
  const needle = options.query?.trim().toLowerCase() ?? "";
  return settings.filter((setting) => {
    if (options.category && setting.category !== options.category) return false;
    if (!needle) return true;
    return (
      setting.key.toLowerCase().includes(needle) ||
      setting.description.toLowerCase().includes(needle) ||
      setting.category.toLowerCase().includes(needle)
    );
  });
}

/** Never renders a secret: the server masks it and the console shows only whether it is set. */
export function settingDisplayValue(setting: EffectiveSetting): string {
  if (setting.is_secret) return setting.is_set ? "설정됨 (표시하지 않음)" : "미설정";
  return setting.value === "" ? "(비어 있음)" : setting.value;
}

const sourceLabels: Record<string, string> = {
  admin: "DB 오버라이드",
  env: "환경변수",
  db_setting: "DB 오버라이드",
  bootstrap_env: "환경변수",
  runtime_flag: "런타임 플래그",
  request_override: "요청 오버라이드",
};

export function settingSourceLabel(source: string | undefined): string {
  if (!source) return "—";
  return sourceLabels[source] ?? source;
}

export interface EditPermission {
  editable: boolean;
  reason?: string;
}

/**
 * Why a setting cannot be edited here. The server is the authority (it answers 403
 * per category), so this only disables controls and explains the reason.
 */
export function settingEditPermission(setting: EffectiveSetting, hasAdminWrite: boolean): EditPermission {
  if (setting.read_only) {
    return { editable: false, reason: "환경변수로만 바꿀 수 있는 읽기 전용 설정입니다." };
  }
  if (setting.can_write === false) {
    return { editable: false, reason: "현재 역할은 이 설정 범주를 변경할 수 없습니다." };
  }
  if (!hasAdminWrite) {
    return { editable: false, reason: "admin:write 권한이 필요합니다." };
  }
  return { editable: true };
}

export interface ConsoleFeatureRow {
  featureId: string;
  status?: EffectiveSetting;
  roles?: EffectiveSetting;
  rollout?: EffectiveSetting;
  readonly?: EffectiveSetting;
}

export function buildConsoleFeatureRows(settings: readonly EffectiveSetting[]): ConsoleFeatureRow[] {
  const rows = new Map<string, ConsoleFeatureRow>();
  for (const setting of settings) {
    const parsed = parseConsoleFeatureKey(setting.key);
    if (!parsed) continue;
    const row = rows.get(parsed.featureId) ?? { featureId: parsed.featureId };
    row[parsed.field] = setting;
    rows.set(parsed.featureId, row);
  }
  return [...rows.values()].sort((left, right) => left.featureId.localeCompare(right.featureId));
}

/** `ui.app.*` keys that are not per-feature (global console switches). */
export function consoleGlobalSettings(settings: readonly EffectiveSetting[]): EffectiveSetting[] {
  return settings.filter(
    (setting) => isConsoleSetting(setting) && parseConsoleFeatureKey(setting.key) === undefined,
  );
}

export const consoleStatusOptions = [
  { value: "hidden", label: "숨김 (hidden)" },
  { value: "legacy", label: "기존 화면 (legacy)" },
  { value: "preview_read_only", label: "미리보기 읽기 전용 (preview_read_only)" },
  { value: "preview", label: "미리보기 (preview)" },
  { value: "stable", label: "정식 (stable)" },
  { value: "deprecated", label: "지원 종료 예정 (deprecated)" },
  { value: "retired", label: "종료 (retired)" },
] as const;

export function isBooleanSetting(setting: EffectiveSetting): boolean {
  return setting.type === "bool";
}

export function normalizedBoolean(value: string): "true" | "false" {
  return value.trim().toLowerCase() === "true" ? "true" : "false";
}
