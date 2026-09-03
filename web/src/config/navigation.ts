import { migrationRegistry } from "@/config/migration-registry";

export const navigationGroups = Array.from(new Set(migrationRegistry.map((feature) => feature.group)));

export const statusLabels = {
  hidden: "숨김",
  legacy: "기존 화면",
  preview_read_only: "읽기 전용",
  preview: "미리보기",
  stable: "안정",
  deprecated: "종료 예정",
  retired: "종료",
} as const;
