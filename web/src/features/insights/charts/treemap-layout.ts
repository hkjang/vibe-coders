// Squarified treemap (Bruls, Huizing and van Wijk): rows are filled along the
// shorter side of the remaining rectangle for as long as that keeps the tiles
// closer to squares. Pure geometry: no React, no DOM.

export interface TreemapInput {
  id: string;
  value: number;
}

export interface TreemapTile {
  id: string;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Scaled {
  id: string;
  value: number;
  area: number;
}

/** Worst aspect ratio in a row of the given areas laid along a side of length `side`. */
export function worstRatio(areas: readonly number[], side: number): number {
  if (areas.length === 0 || side <= 0) return Number.POSITIVE_INFINITY;
  const sum = areas.reduce((total, area) => total + area, 0);
  const largest = Math.max(...areas);
  const smallest = Math.min(...areas);
  if (sum <= 0 || smallest <= 0) return Number.POSITIVE_INFINITY;
  const square = side * side;
  return Math.max((square * largest) / (sum * sum), (sum * sum) / (square * smallest));
}

function placeRow(row: readonly Scaled[], box: Box, tiles: TreemapTile[]): Box {
  const sum = row.reduce((total, item) => total + item.area, 0);
  if (box.width >= box.height) {
    // A column on the left; tiles stack top to bottom.
    const thickness = box.height > 0 ? sum / box.height : 0;
    let offset = box.y;
    for (const item of row) {
      const length = thickness > 0 ? item.area / thickness : 0;
      tiles.push({ id: item.id, value: item.value, x: box.x, y: offset, width: thickness, height: length });
      offset += length;
    }
    return { x: box.x + thickness, y: box.y, width: Math.max(0, box.width - thickness), height: box.height };
  }
  // A band on top; tiles run left to right.
  const thickness = box.width > 0 ? sum / box.width : 0;
  let offset = box.x;
  for (const item of row) {
    const length = thickness > 0 ? item.area / thickness : 0;
    tiles.push({ id: item.id, value: item.value, x: offset, y: box.y, width: length, height: thickness });
    offset += length;
  }
  return { x: box.x, y: box.y + thickness, width: box.width, height: Math.max(0, box.height - thickness) };
}

/**
 * Tiles for the positive values, largest first, that exactly fill `width × height`.
 * Non-positive and non-finite values get no tile.
 */
export function squarify(items: readonly TreemapInput[], width: number, height: number): TreemapTile[] {
  if (!(width > 0) || !(height > 0)) return [];
  const positive = items
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
    .sort((left, right) => right.value - left.value);
  const total = positive.reduce((sum, item) => sum + item.value, 0);
  if (total <= 0) return [];
  const scale = (width * height) / total;
  const queue: Scaled[] = positive.map((item) => ({ ...item, area: item.value * scale }));

  const tiles: TreemapTile[] = [];
  let box: Box = { x: 0, y: 0, width, height };
  let row: Scaled[] = [];
  for (const item of queue) {
    const side = Math.min(box.width, box.height);
    const current = row.map((entry) => entry.area);
    if (row.length === 0 || worstRatio([...current, item.area], side) <= worstRatio(current, side)) {
      row.push(item);
      continue;
    }
    box = placeRow(row, box, tiles);
    row = [item];
  }
  if (row.length > 0) placeRow(row, box, tiles);
  return tiles;
}
