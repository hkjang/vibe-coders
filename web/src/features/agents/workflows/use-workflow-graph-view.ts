import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

export const graphZoomLevels = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;

export function fitGraphScale(width: number, height: number, viewportWidth: number, viewportHeight: number) {
  if (viewportWidth <= 16 || viewportHeight <= 16) return 1;
  return Math.min(1, (viewportWidth - 16) / width, (viewportHeight - 16) / height);
}

export function nextGraphScale(scale: number, direction: "in" | "out"): number {
  return direction === "in"
    ? (graphZoomLevels.find((level) => level > scale + 0.001) ?? 2)
    : ([...graphZoomLevels].reverse().find((level) => level < scale - 0.001) ?? 0.25);
}

export function useWorkflowGraphView(
  width: number,
  height: number,
  selected: string,
  point: { x: number; y: number } | undefined,
) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState<number | "fit">(1);
  const [centerRequest, setCenterRequest] = useState(0);
  const subscribe = useCallback((changed: () => void) => {
    const element = viewportRef.current;
    if (!element || typeof ResizeObserver === "undefined") return () => undefined;
    const observer = new ResizeObserver(changed);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const measure = useCallback(
    () => `${viewportRef.current?.clientWidth ?? 0}:${viewportRef.current?.clientHeight ?? 0}`,
    [],
  );
  const size = useSyncExternalStore(subscribe, measure, () => "0:0");
  const [viewportWidth = 0, viewportHeight = 0] = size.split(":").map(Number);
  const scale = zoom === "fit" ? fitGraphScale(width, height, viewportWidth, viewportHeight) : zoom;
  const x = point?.x,
    y = point?.y;
  useLayoutEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    // Scroll only this drawing. The editor, dialog and page retain their own
    // positions and keyboard focus, including when the select is below it.
    // SVG bounds can settle after the React commit (and its next frame).
    // Observe the actual canvas resize so restoring from fit never centers
    // against the previous, smaller scrollable area.
    const center = () => {
      element.scrollLeft =
        zoom === "fit" || x === undefined ? 0 : Math.max(0, (x + 94) * scale - viewportWidth / 2);
      element.scrollTop =
        zoom === "fit" || y === undefined ? 0 : Math.max(0, (y + 36) * scale - viewportHeight / 2);
    };
    center();
    const canvas = element.firstElementChild;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(center);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [selected, x, y, zoom, scale, viewportWidth, viewportHeight, centerRequest]);
  return [
    viewportRef,
    {
      scale,
      fit: zoom === "fit",
      zoomIn: () => setZoom(nextGraphScale(scale, "in")),
      zoomOut: () => setZoom(nextGraphScale(scale, "out")),
      fitAll: () => setZoom("fit"),
      reveal: () => {
        setZoom(1);
        setCenterRequest((value) => value + 1);
      },
    },
  ] as const;
}
