import type { ColumnOrderState, ColumnSizingState, ColumnVisibilityState } from "@tanstack/react-table";

export const minimumDataTableColumnWidth = 80;
export const maximumDataTableColumnWidth = 640;

const preferenceVersion = 1;
const storagePrefix = "vibe.app.table.v1.";
const tableIdPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/;

export interface DataTablePreferences {
  columnOrder: ColumnOrderState;
  columnSizing: ColumnSizingState;
  columnVisibility: ColumnVisibilityState;
}

interface StoredDataTablePreferences extends DataTablePreferences {
  version: typeof preferenceVersion;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function uniqueAllowedColumnIds(columnIds: readonly string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const columnId of columnIds) {
    if (columnId === "" || seen.has(columnId)) continue;
    seen.add(columnId);
    unique.push(columnId);
  }
  return unique;
}

export function normalizeDataTableId(tableId: string | undefined): string | undefined {
  const normalized = tableId?.trim();
  return normalized && tableIdPattern.test(normalized) ? normalized : undefined;
}

export function dataTablePreferenceStorageKey(tableId: string): string {
  return `${storagePrefix}${tableId}`;
}

export function clampDataTableColumnWidth(value: number): number {
  if (!Number.isFinite(value)) return minimumDataTableColumnWidth;
  return Math.min(maximumDataTableColumnWidth, Math.max(minimumDataTableColumnWidth, Math.round(value)));
}

/**
 * Keeps only layout metadata that belongs to columns in the current table.
 * Row values, filters, cursors and identifiers have no representation in this
 * type and therefore cannot be copied into localStorage by the table shell.
 */
export function sanitizeDataTablePreferences(
  value: unknown,
  allowedColumnIds: readonly string[],
  lockedColumnIds: readonly string[] = [],
): DataTablePreferences {
  const allowed = uniqueAllowedColumnIds(allowedColumnIds);
  const allowedSet = new Set(allowed);
  const lockedSet = new Set(lockedColumnIds.filter((columnId) => allowedSet.has(columnId)));
  const record = isRecord(value) ? value : {};

  const requestedOrder = Array.isArray(record.columnOrder) ? record.columnOrder : [];
  const columnOrder: string[] = [];
  const orderedSet = new Set<string>();
  for (const entry of requestedOrder) {
    if (typeof entry !== "string" || !allowedSet.has(entry) || orderedSet.has(entry)) continue;
    orderedSet.add(entry);
    columnOrder.push(entry);
  }
  for (const columnId of allowed) {
    if (orderedSet.has(columnId)) continue;
    orderedSet.add(columnId);
    columnOrder.push(columnId);
  }

  const columnVisibility: ColumnVisibilityState = {};
  if (isRecord(record.columnVisibility)) {
    for (const columnId of allowed) {
      if (!lockedSet.has(columnId) && record.columnVisibility[columnId] === false) {
        columnVisibility[columnId] = false;
      }
    }
  }
  if (allowed.length > 0 && allowed.every((columnId) => columnVisibility[columnId] === false)) {
    const firstColumnId = allowed[0];
    if (firstColumnId) columnVisibility[firstColumnId] = true;
  }

  const columnSizing: ColumnSizingState = {};
  if (isRecord(record.columnSizing)) {
    for (const columnId of allowed) {
      const width = record.columnSizing[columnId];
      if (typeof width === "number" && Number.isFinite(width)) {
        columnSizing[columnId] = clampDataTableColumnWidth(width);
      }
    }
  }

  return { columnOrder, columnSizing, columnVisibility };
}

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export function loadDataTablePreferences(
  tableId: string,
  allowedColumnIds: readonly string[],
  lockedColumnIds: readonly string[] = [],
): DataTablePreferences {
  const storage = browserStorage();
  if (!storage) return sanitizeDataTablePreferences(undefined, allowedColumnIds, lockedColumnIds);
  const storageKey = dataTablePreferenceStorageKey(tableId);
  try {
    const stored = storage.getItem(storageKey);
    if (!stored) return sanitizeDataTablePreferences(undefined, allowedColumnIds, lockedColumnIds);
    const parsed: unknown = JSON.parse(stored);
    if (!isRecord(parsed) || parsed.version !== preferenceVersion) {
      storage.removeItem(storageKey);
      return sanitizeDataTablePreferences(undefined, allowedColumnIds, lockedColumnIds);
    }
    const safe = sanitizeDataTablePreferences(parsed, allowedColumnIds, lockedColumnIds);
    const normalized = JSON.stringify({
      version: preferenceVersion,
      ...safe,
    } satisfies StoredDataTablePreferences);
    if (normalized !== stored) storage.setItem(storageKey, normalized);
    return safe;
  } catch {
    try {
      storage.removeItem(storageKey);
    } catch {
      // Storage may be unavailable; in-memory defaults still keep the table usable.
    }
    return sanitizeDataTablePreferences(undefined, allowedColumnIds, lockedColumnIds);
  }
}

export function saveDataTablePreferences(
  tableId: string,
  preferences: DataTablePreferences,
  allowedColumnIds: readonly string[],
  lockedColumnIds: readonly string[] = [],
): void {
  const storage = browserStorage();
  if (!storage) return;
  const safe = sanitizeDataTablePreferences(preferences, allowedColumnIds, lockedColumnIds);
  const stored: StoredDataTablePreferences = { version: preferenceVersion, ...safe };
  try {
    storage.setItem(dataTablePreferenceStorageKey(tableId), JSON.stringify(stored));
  } catch {
    // A private browser context or full quota must not make the table unusable.
  }
}

export function resetDataTablePreferences(tableId: string): void {
  try {
    browserStorage()?.removeItem(dataTablePreferenceStorageKey(tableId));
  } catch {
    // Resetting the in-memory state remains useful when storage is unavailable.
  }
}
