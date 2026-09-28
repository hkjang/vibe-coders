import { functionalUpdate, useTable, type RowData, type Updater } from "@tanstack/react-table";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { dataTableFeatures, type DataTableColumn } from "@/shared/data-table/columns";
import {
  clampDataTableColumnWidth,
  loadDataTablePreferences,
  maximumDataTableColumnWidth,
  minimumDataTableColumnWidth,
  normalizeDataTableId,
  resetDataTablePreferences,
  sanitizeDataTablePreferences,
  saveDataTablePreferences,
  type DataTablePreferences,
} from "@/shared/data-table/table-preferences";

interface PreferenceContext {
  allowedColumnIds: string[];
  configurationKey: string;
  initialized: boolean;
  lockedColumnIds: string[];
  tableId?: string;
}

function preferenceContextFromKey(configurationKey: string): PreferenceContext {
  const parsed: unknown = JSON.parse(configurationKey);
  if (!Array.isArray(parsed)) {
    return { allowedColumnIds: [], configurationKey, initialized: false, lockedColumnIds: [] };
  }
  const [rawTableId, rawAllowedColumnIds, rawLockedColumnIds] = parsed;
  return {
    allowedColumnIds: Array.isArray(rawAllowedColumnIds)
      ? rawAllowedColumnIds.filter((entry): entry is string => typeof entry === "string")
      : [],
    configurationKey,
    initialized: false,
    lockedColumnIds: Array.isArray(rawLockedColumnIds)
      ? rawLockedColumnIds.filter((entry): entry is string => typeof entry === "string")
      : [],
    tableId: typeof rawTableId === "string" && rawTableId !== "" ? rawTableId : undefined,
  };
}

interface UseDataTableLayoutOptions<TData extends RowData> {
  columns: ReadonlyArray<DataTableColumn<TData>>;
  data: ReadonlyArray<TData>;
  getRowId?: (row: TData, index: number) => string;
  lockedColumnIds: readonly string[];
  tableId?: string;
}

export interface DataTableSettingsColumn {
  canMoveLeft: boolean;
  canMoveRight: boolean;
  disabledVisibility: boolean;
  id: string;
  label: string;
  locked: boolean;
  visible: boolean;
  width: number;
}

export interface DataTableScrollState {
  atEnd: boolean;
  atStart: boolean;
  overflowing: boolean;
}

const initialPreferences: DataTablePreferences = {
  columnOrder: [],
  columnSizing: {},
  columnVisibility: {},
};
const initialScrollState: DataTableScrollState = {
  atEnd: true,
  atStart: true,
  overflowing: false,
};

export function dataTableColumnLabel(column: { columnDef: { header?: unknown }; id: string }): string {
  return typeof column.columnDef.header === "string" ? column.columnDef.header : column.id;
}

export function useDataTableLayout<TData extends RowData>({
  columns,
  data,
  getRowId,
  lockedColumnIds,
  tableId,
}: UseDataTableLayoutOptions<TData>) {
  const persistentTableId = useMemo(() => normalizeDataTableId(tableId), [tableId]);
  const [preferences, setPreferences] = useState<DataTablePreferences>(initialPreferences);
  const [settingsAnnouncement, setSettingsAnnouncement] = useState("");
  const preferenceContextRef = useRef<PreferenceContext>({
    allowedColumnIds: [],
    configurationKey: "",
    initialized: false,
    lockedColumnIds: [],
  });

  const commitPreferences = useCallback((next: DataTablePreferences): DataTablePreferences => {
    const context = preferenceContextRef.current;
    const safe = sanitizeDataTablePreferences(next, context.allowedColumnIds, context.lockedColumnIds);
    if (context.initialized && context.tableId) {
      saveDataTablePreferences(context.tableId, safe, context.allowedColumnIds, context.lockedColumnIds);
    }
    return safe;
  }, []);

  const updateColumnOrder = useCallback(
    (updater: Updater<DataTablePreferences["columnOrder"]>): void => {
      setPreferences((current) =>
        commitPreferences({
          ...current,
          columnOrder: functionalUpdate(updater, current.columnOrder),
        }),
      );
    },
    [commitPreferences],
  );
  const updateColumnSizing = useCallback(
    (updater: Updater<DataTablePreferences["columnSizing"]>): void => {
      setPreferences((current) =>
        commitPreferences({
          ...current,
          columnSizing: functionalUpdate(updater, current.columnSizing),
        }),
      );
    },
    [commitPreferences],
  );
  const updateColumnVisibility = useCallback(
    (updater: Updater<DataTablePreferences["columnVisibility"]>): void => {
      setPreferences((current) =>
        commitPreferences({
          ...current,
          columnVisibility: functionalUpdate(updater, current.columnVisibility),
        }),
      );
    },
    [commitPreferences],
  );

  const table = useTable({
    columns,
    data,
    defaultColumn: {
      maxSize: maximumDataTableColumnWidth,
      minSize: minimumDataTableColumnWidth,
      size: 160,
    },
    enableColumnResizing: persistentTableId !== undefined,
    features: dataTableFeatures,
    getRowId,
    columnResizeMode: "onEnd",
    state: {
      columnOrder: preferences.columnOrder,
      columnSizing: preferences.columnSizing,
      columnVisibility: preferences.columnVisibility,
    },
    onColumnOrderChange: updateColumnOrder,
    onColumnSizingChange: updateColumnSizing,
    onColumnVisibilityChange: updateColumnVisibility,
  });

  const allLeafColumns = table.getAllLeafColumns();
  const canonicalLeafColumns: typeof allLeafColumns = [];
  const appendCanonicalLeaves = (candidateColumns: typeof allLeafColumns): void => {
    for (const column of candidateColumns) {
      if (column.columns.length > 0) appendCanonicalLeaves(column.columns);
      else canonicalLeafColumns.push(column);
    }
  };
  appendCanonicalLeaves(table.getAllColumns());
  const allowedColumnIds = canonicalLeafColumns.map((column) => column.id);
  const lockedSetFromProps = new Set(lockedColumnIds);
  const effectiveLockedColumnIds = canonicalLeafColumns
    .filter((column) => lockedSetFromProps.has(column.id) || !column.getCanHide())
    .map((column) => column.id);
  const configurationKey = JSON.stringify([
    persistentTableId ?? "",
    allowedColumnIds,
    effectiveLockedColumnIds,
  ]);
  useEffect(() => {
    const context = preferenceContextFromKey(configurationKey);
    preferenceContextRef.current = context;
    const next = context.tableId
      ? loadDataTablePreferences(context.tableId, context.allowedColumnIds, context.lockedColumnIds)
      : sanitizeDataTablePreferences(undefined, context.allowedColumnIds, context.lockedColumnIds);
    // localStorage is an external preference source. Reload only when this
    // table's identity or allowed column schema changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPreferences(next);
    if (context.configurationKey === configurationKey) context.initialized = true;
  }, [configurationKey]);

  const visibleLeafColumns = table.getVisibleLeafColumns();
  const visibleColumnCount = visibleLeafColumns.length;
  const columnById = new Map(allLeafColumns.map((column) => [column.id, column]));
  const orderedColumns = preferences.columnOrder
    .map((columnId) => columnById.get(columnId))
    .filter((column): column is (typeof allLeafColumns)[number] => column !== undefined);
  for (const column of allLeafColumns) {
    if (!orderedColumns.some((ordered) => ordered.id === column.id)) orderedColumns.push(column);
  }
  const effectiveLockedSet = new Set(effectiveLockedColumnIds);
  const settingsColumns: DataTableSettingsColumn[] = orderedColumns.map((column, index) => {
    const visible = column.getIsVisible();
    const locked = effectiveLockedSet.has(column.id);
    return {
      canMoveLeft: index > 0,
      canMoveRight: index < orderedColumns.length - 1,
      disabledVisibility: locked || (visible && visibleColumnCount <= 1),
      id: column.id,
      label: dataTableColumnLabel(column),
      locked,
      visible,
      width: Math.round(column.getSize()),
    };
  });

  const resizeColumn = (columnId: string, requestedWidth: number): void => {
    table.setColumnSizing((current) => ({
      ...current,
      [columnId]: clampDataTableColumnWidth(requestedWidth),
    }));
    const column = columnById.get(columnId);
    setSettingsAnnouncement(
      `${dataTableColumnLabel(column ?? { id: columnId, columnDef: {} })} 열 너비를 조정했습니다.`,
    );
  };

  const resizeColumnByKey = (columnId: string, currentWidth: number, key: string): boolean => {
    let requestedWidth: number | undefined;
    if (key === "ArrowLeft") requestedWidth = currentWidth - 16;
    else if (key === "ArrowRight") requestedWidth = currentWidth + 16;
    else if (key === "Home") requestedWidth = minimumDataTableColumnWidth;
    else if (key === "End") requestedWidth = maximumDataTableColumnWidth;
    if (requestedWidth === undefined) return false;
    resizeColumn(columnId, requestedWidth);
    return true;
  };

  const moveColumn = (columnId: string, direction: -1 | 1): void => {
    const currentOrder = orderedColumns.map((column) => column.id);
    const currentIndex = currentOrder.indexOf(columnId);
    const destination = currentIndex + direction;
    if (currentIndex < 0 || destination < 0 || destination >= currentOrder.length) return;
    [currentOrder[currentIndex], currentOrder[destination]] = [
      currentOrder[destination] ?? columnId,
      currentOrder[currentIndex] ?? columnId,
    ];
    table.setColumnOrder(currentOrder);
    const column = columnById.get(columnId);
    setSettingsAnnouncement(
      `${dataTableColumnLabel(column ?? { id: columnId, columnDef: {} })} 열을 ${direction < 0 ? "왼쪽" : "오른쪽"}으로 이동했습니다.`,
    );
  };

  const resetSettings = (): void => {
    setPreferences(sanitizeDataTablePreferences(undefined, allowedColumnIds, effectiveLockedColumnIds));
    if (persistentTableId) resetDataTablePreferences(persistentTableId);
    setSettingsAnnouncement("표시 열, 열 순서와 열 너비를 기본값으로 되돌렸습니다.");
  };

  return {
    allLeafColumns,
    configurable: persistentTableId !== undefined,
    layoutVersion: JSON.stringify(preferences),
    moveColumn,
    resetSettings,
    resizeColumnByKey,
    settingsAnnouncement,
    settingsColumns,
    table,
    toggleColumnVisibility: (columnId: string, visible: boolean): void => {
      columnById.get(columnId)?.toggleVisibility(visible);
    },
    visibleColumnCount,
    visibleLeafColumns,
  };
}

function sameScrollState(left: DataTableScrollState, right: DataTableScrollState): boolean {
  return (
    left.atEnd === right.atEnd && left.atStart === right.atStart && left.overflowing === right.overflowing
  );
}

export function useDataTableOverflow(data: unknown, loading: boolean, layoutVersion: string) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollState, setScrollState] = useState<DataTableScrollState>(initialScrollState);
  const updateScrollState = useCallback((): void => {
    const element = scrollRef.current;
    if (!element) return;
    const maximumScroll = Math.max(0, element.scrollWidth - element.clientWidth);
    const overflowing = maximumScroll > 1;
    const next = {
      atEnd: !overflowing || element.scrollLeft >= maximumScroll - 1,
      atStart: !overflowing || element.scrollLeft <= 1,
      overflowing,
    };
    setScrollState((current) => (sameScrollState(current, next) ? current : next));
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    updateScrollState();
    const ResizeObserverConstructor = globalThis.ResizeObserver;
    const observer =
      typeof ResizeObserverConstructor === "function"
        ? new ResizeObserverConstructor(updateScrollState)
        : undefined;
    observer?.observe(element);
    const renderedTable = element.querySelector("table");
    if (renderedTable) observer?.observe(renderedTable);
    window.addEventListener("resize", updateScrollState);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateScrollState);
    };
  }, [data, layoutVersion, loading, updateScrollState]);

  return { scrollRef, scrollState, updateScrollState };
}
