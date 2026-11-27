import { useMemo } from "react";

import { ChartEmpty, ChartTable, PaintDefs } from "./chart-parts";
import { paintFill, type CategoryPaint } from "./palette";
import { sankeyLayout, type SankeyLinkInput, type SankeyNode, type SankeyNodeInput } from "./sankey-layout";
import { useChartId } from "./use-chart-id";
import "./charts.css";

export interface SankeyColumn {
  kind: string;
  label: string;
}

interface SankeyChartProps {
  caption: string;
  /** Node kinds left to right, with the heading printed over each column. */
  columns: readonly SankeyColumn[];
  nodes: readonly SankeyNodeInput[];
  links: readonly SankeyLinkInput[];
  paintOf: (node: SankeyNodeInput) => CategoryPaint;
  format: (value: number) => string;
  valueHeader: string;
  /** Kinds whose nodes can be selected. */
  selectableKinds?: readonly string[];
  /** Further narrows which nodes can be selected, e.g. not a folded remainder. */
  isSelectable?: (node: SankeyNodeInput) => boolean;
  onSelect?: (node: SankeyNodeInput) => void;
  selectHint?: string;
}

const width = 720;
const nodeWidth = 12;
const nodeGap = 14;
const labelWidth = 170;
const padding = { top: 30, right: 8, bottom: 10, left: 8 };
const minimumHit = 24;

const shorten = (text: string, limit = 18): string =>
  [...text].length > limit ? `${[...text].slice(0, limit - 1).join("")}…` : text;

/** Flow between three columns. Ribbon thickness and node height share one scale. */
export function SankeyChart({
  caption,
  columns,
  nodes,
  links,
  paintOf,
  format,
  valueHeader,
  selectableKinds = [],
  isSelectable,
  onSelect,
  selectHint,
}: SankeyChartProps): React.JSX.Element {
  const id = useChartId();
  const kinds = useMemo(() => columns.map((column) => column.kind), [columns]);
  const height = useMemo(() => {
    const tallest = Math.max(1, ...kinds.map((kind) => nodes.filter((node) => node.kind === kind).length));
    return Math.max(260, padding.top + padding.bottom + tallest * (22 + nodeGap));
  }, [kinds, nodes]);
  const layout = useMemo(
    () => sankeyLayout(nodes, links, { width, height, padding, nodeWidth, nodeGap, columns: kinds }),
    [nodes, links, height, kinds],
  );
  if (layout.nodes.length === 0 || layout.links.length === 0) {
    return <ChartEmpty>표시할 흐름이 없습니다.</ChartEmpty>;
  }

  const byId = new Map(layout.nodes.map((node) => [node.id, node]));
  const last = columns.length - 1;
  const paints = layout.nodes.map(paintOf);
  // A ribbon wears the colour of the middle column's node it touches (the work category).
  const linkPaint = (source: SankeyNode, target: SankeyNode): CategoryPaint =>
    paintOf(source.column === 0 ? target : source);

  return (
    <figure className="wi-viz wi-chart">
      <div className="wi-chart-scroll" tabIndex={0} role="region" aria-label={`${caption} 그래프 영역`}>
        <div className="wi-chart-canvas wi-chart-wide">
          <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title`}>
            <title id={`${id}-title`}>{caption}</title>
            <PaintDefs id={id} paints={paints} />
            {columns.map((column, index) => {
              const x =
                index === last
                  ? width - padding.right
                  : padding.left +
                    (index * (width - padding.left - padding.right - nodeWidth)) / Math.max(1, last);
              return (
                <text
                  key={column.kind}
                  className="wi-axis-text"
                  x={x}
                  y={14}
                  textAnchor={index === last ? "end" : "start"}
                >
                  {column.label}
                </text>
              );
            })}
            {layout.links.map((link) => {
              const source = byId.get(link.source);
              const target = byId.get(link.target);
              if (!source || !target) return null;
              return (
                <path
                  key={`${link.source}→${link.target}`}
                  d={link.path}
                  style={{ fill: paintFill(linkPaint(source, target), id), fillOpacity: 0.32 }}
                >
                  <title>{`${source.name} → ${target.name} · ${format(link.value)}`}</title>
                </path>
              );
            })}
            {layout.nodes.map((node) => {
              const paint = paintOf(node);
              const labelX = node.column === last ? node.x - 6 : node.x + node.width + 6;
              const middle = node.y + node.height / 2;
              return (
                <g key={node.id}>
                  <rect
                    x={node.x}
                    y={node.y}
                    width={node.width}
                    height={Math.max(1.5, node.height)}
                    rx={2}
                    style={{ fill: paintFill(paint, id) }}
                  >
                    <title>{`${node.name} · ${format(node.value)}`}</title>
                  </rect>
                  <text
                    className="wi-label-text"
                    x={labelX}
                    y={middle + 4}
                    textAnchor={node.column === last ? "end" : "start"}
                    style={{ paintOrder: "stroke", stroke: "var(--color-card)", strokeWidth: 3 }}
                  >
                    {shorten(node.name)}
                    <tspan className="wi-axis-text" dx={6}>
                      {format(node.value)}
                    </tspan>
                  </text>
                </g>
              );
            })}
          </svg>
          {onSelect
            ? layout.nodes
                .filter((node) => selectableKinds.includes(node.kind) && (isSelectable?.(node) ?? true))
                .map((node) => {
                  const hitHeight = Math.max(minimumHit, node.height);
                  const top = node.y + node.height / 2 - hitHeight / 2;
                  const left = node.column === last ? node.x - labelWidth : node.x;
                  const column = columns[node.column]?.label ?? "";
                  return (
                    <button
                      key={node.id}
                      type="button"
                      className="wi-hit"
                      style={{
                        left: `${(left / width) * 100}%`,
                        top: `${(top / height) * 100}%`,
                        width: `${((labelWidth + node.width) / width) * 100}%`,
                        height: `${(hitHeight / height) * 100}%`,
                      }}
                      aria-label={`${column} ${node.name} · ${format(node.value)}${selectHint ? ` · ${selectHint}` : ""}`}
                      title={`${node.name} · ${format(node.value)}`}
                      onClick={() => onSelect(node)}
                    />
                  );
                })
            : null}
        </div>
      </div>
      <ChartTable
        caption={caption}
        head={["흐름", valueHeader]}
        rows={layout.links.map((link) => [
          `${byId.get(link.source)?.name ?? link.source} → ${byId.get(link.target)?.name ?? link.target}`,
          format(link.value),
        ])}
      />
    </figure>
  );
}
