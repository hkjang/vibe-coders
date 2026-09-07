import { describe, expect, it } from "vitest";

import {
  buildConsoleFeatureRows,
  consoleGlobalSettings,
  filterSettings,
  isConsoleSetting,
  parseConsoleFeatureKey,
  settingCategories,
  settingDisplayValue,
  settingEditPermission,
  settingSourceLabel,
} from "@/features/system/settings/settings-utils";
import type { EffectiveSetting } from "@/shared/api/domains/system.schemas";

function setting(overrides: Partial<EffectiveSetting> & { key: string }): EffectiveSetting {
  return {
    category: "general",
    description: "",
    is_secret: false,
    read_only: false,
    restart_required: false,
    source: "env",
    type: "string",
    value: "",
    ...overrides,
  } as EffectiveSetting;
}

describe("settings-utils", () => {
  it("parses per-feature console keys and ignores other keys", () => {
    expect(parseConsoleFeatureKey("ui.app.feature.system.settings.status")).toEqual({
      featureId: "system.settings",
      field: "status",
    });
    expect(parseConsoleFeatureKey("ui.app.feature.overview.rollout")).toEqual({
      featureId: "overview",
      field: "rollout",
    });
    expect(parseConsoleFeatureKey("ui.app.enabled")).toBeUndefined();
    expect(parseConsoleFeatureKey("clickhouse.url")).toBeUndefined();
    expect(parseConsoleFeatureKey("ui.app.feature.overview.unknown")).toBeUndefined();
  });

  it("splits console settings from runtime settings", () => {
    const rows = [
      setting({ key: "clickhouse.url" }),
      setting({ key: "ui.app.enabled", category: "ui.app" }),
      setting({ key: "ui.app.feature.overview.status", category: "ui.app.features" }),
    ];
    expect(rows.filter(isConsoleSetting).map((row) => row.key)).toEqual([
      "ui.app.enabled",
      "ui.app.feature.overview.status",
    ]);
    expect(consoleGlobalSettings(rows).map((row) => row.key)).toEqual(["ui.app.enabled"]);
    expect(buildConsoleFeatureRows(rows)).toEqual([{ featureId: "overview", status: rows[2] }]);
  });

  it("never renders a secret value", () => {
    expect(settingDisplayValue(setting({ key: "a", is_secret: true, is_set: true, value: "********" }))).toBe(
      "설정됨 (표시하지 않음)",
    );
    expect(settingDisplayValue(setting({ key: "a", is_secret: true, is_set: false, value: "" }))).toBe(
      "미설정",
    );
    expect(settingDisplayValue(setting({ key: "a", value: "" }))).toBe("(비어 있음)");
    expect(settingDisplayValue(setting({ key: "a", value: "http://ch:8123" }))).toBe("http://ch:8123");
  });

  it("explains why a setting cannot be edited", () => {
    expect(settingEditPermission(setting({ key: "a", read_only: true }), true).reason).toContain("읽기 전용");
    expect(settingEditPermission(setting({ key: "a", can_write: false }), true).reason).toContain("역할");
    expect(settingEditPermission(setting({ key: "a", can_write: true }), false).reason).toContain(
      "admin:write",
    );
    expect(settingEditPermission(setting({ key: "a", can_write: true }), true)).toEqual({ editable: true });
  });

  it("filters by category and free text", () => {
    const rows = [
      setting({ key: "clickhouse.url", category: "clickhouse", description: "ClickHouse 주소" }),
      setting({ key: "text2sql.enabled", category: "text2sql", description: "Text2SQL 사용" }),
    ];
    expect(settingCategories(rows)).toEqual(["clickhouse", "text2sql"]);
    expect(filterSettings(rows, { category: "text2sql" }).map((row) => row.key)).toEqual([
      "text2sql.enabled",
    ]);
    expect(filterSettings(rows, { query: "text2sql" }).map((row) => row.key)).toEqual(["text2sql.enabled"]);
    expect(filterSettings(rows, { query: "ClickHouse" }).map((row) => row.key)).toEqual(["clickhouse.url"]);
  });

  it("labels resolution sources in Korean", () => {
    expect(settingSourceLabel("admin")).toBe("DB 오버라이드");
    expect(settingSourceLabel("env")).toBe("환경변수");
    expect(settingSourceLabel(undefined)).toBe("—");
  });
});
