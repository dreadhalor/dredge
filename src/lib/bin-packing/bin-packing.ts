import { PackedItem, SlotType } from '@dredge/types';

// Offsets of a shape's cells from its first cell in reading order
type Orientation = { dr: number[]; dc: number[] };

// Every item with the same shape (up to rotation) is interchangeable while searching
type PieceType = {
  area: number;
  orientations: Orientation[];
  items: PackedItem[];
  count: number;
};

export const binPacking = (
  items: PackedItem[],
  grid: number[][],
): PackedItem[] | null => {
  const rows = grid.length;
  const cols = grid[0].length;
  const available = new Uint8Array(rows * cols);
  grid.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell === SlotType.Available) available[r * cols + c] = 1;
    }),
  );
  const availableCells = available.reduce((sum, cell) => sum + cell, 0);

  // 1-slot items never enter the search: they fit in any leftover cell
  const multiSlotItems = items.filter((item) => countCells(item.shape) > 1);
  const singleSlotItems = items.filter((item) => countCells(item.shape) === 1);

  const totalItemCells = items.reduce(
    (sum, item) => sum + countCells(item.shape),
    0,
  );
  if (totalItemCells > availableCells) {
    return null; // No valid bin packing solution possible
  }

  // Optimization: keep every already-placed item where it is and only look for room for
  // the new ones, so adding an item doesn't reshuffle the hold. Otherwise re-pack it all.
  const warmStart = (): Map<PackedItem, number[]> | null => {
    const free = available.slice();
    const kept = new Map<PackedItem, number[]>();
    const unplaced: PackedItem[] = [];
    for (const item of multiSlotItems) {
      const cells = cellsAtHint(item, free, rows, cols);
      if (!cells) {
        unplaced.push(item);
        continue;
      }
      cells.forEach((cell) => (free[cell] = 0));
      kept.set(item, cells);
    }
    if (kept.size === 0) return null;
    const rest = search(free, unplaced, rows, cols);
    return rest && new Map([...kept, ...rest]);
  };

  const placements =
    warmStart() ?? search(available, multiSlotItems, rows, cols);
  if (!placements) {
    return null; // No valid bin packing solution found for multi-slot items
  }

  // Fill in the gaps with single-slot items, leaving any that are still in an open slot
  const open = available.slice();
  for (const cells of placements.values()) {
    cells.forEach((cell) => (open[cell] = 0));
  }
  const singleSlots = new Map<PackedItem, number>();
  for (const item of singleSlotItems) {
    const cells = cellsAtHint(item, open, rows, cols);
    if (cells) {
      open[cells[0]] = 0;
      singleSlots.set(item, cells[0]);
    }
  }
  let nextOpen = 0;
  for (const item of singleSlotItems) {
    if (singleSlots.has(item)) continue;
    while (!open[nextOpen]) nextOpen++;
    open[nextOpen] = 0;
    singleSlots.set(item, nextOpen);
  }

  return items.map((item) => {
    const slot = singleSlots.get(item);
    if (slot !== undefined) {
      return {
        ...item,
        rotation: 0,
        topLeft: [Math.floor(slot / cols), slot % cols],
      };
    }
    return { ...item, ...toPlacement(item, placements.get(item)!, cols) };
  });
};

// Places pieces into the free cells, returning each piece's cells, or null if they don't fit.
//
// Always fills the first undecided cell: either with a piece whose first cell lands there,
// or by deliberately leaving it empty (spending one cell of slack). That generates every
// arrangement exactly once, so twins are never retried in swapped order.
const search = (
  initialFree: Uint8Array,
  pieces: PackedItem[],
  rows: number,
  cols: number,
): Map<PackedItem, number[]> | null => {
  const free = initialFree.slice();
  const size = rows * cols;
  const freeCells = free.reduce((sum, cell) => sum + cell, 0);
  const types = groupByShape(pieces).sort((a, b) => b.area - a.area);
  let remainingArea = pieces.reduce(
    (sum, item) => sum + countCells(item.shape),
    0,
  );
  if (remainingArea > freeCells) return null;

  const placed: { type: PieceType; cells: number[] }[] = [];
  const stack = new Int32Array(size);
  const seen = new Uint8Array(size);

  const smallestRemainingArea = () => {
    for (let i = types.length - 1; i >= 0; i--) {
      if (types[i].count > 0) return types[i].area;
    }
    return Infinity;
  };

  // Free pockets smaller than every remaining piece can never be filled, so their cells
  // will have to be left empty. Stops counting once the total passes the limit.
  const deadCells = (from: number, limit: number) => {
    const minArea = smallestRemainingArea();
    seen.fill(0);
    let dead = 0;
    for (let start = from; start < size; start++) {
      if (!free[start] || seen[start]) continue;
      let top = 0;
      let pocket = 0;
      stack[top++] = start;
      seen[start] = 1;
      while (top) {
        const cell = stack[--top];
        pocket++;
        const r = Math.floor(cell / cols);
        const c = cell - r * cols;
        const visit = (next: number) => {
          if (free[next] && !seen[next]) {
            seen[next] = 1;
            stack[top++] = next;
          }
        };
        if (r > 0) visit(cell - cols);
        if (r < rows - 1) visit(cell + cols);
        if (c > 0) visit(cell - 1);
        if (c < cols - 1) visit(cell + 1);
      }
      if (pocket < minArea) {
        dead += pocket;
        if (dead > limit) return dead;
      }
    }
    return dead;
  };

  const fit = (r: number, c: number, { dr, dc }: Orientation) => {
    const cells: number[] = [];
    for (let k = 0; k < dr.length; k++) {
      const row = r + dr[k];
      const col = c + dc[k];
      if (row >= rows || col < 0 || col >= cols || !free[row * cols + col]) {
        return null;
      }
      cells.push(row * cols + col);
    }
    return cells;
  };

  const place = (pos: number, slack: number): boolean => {
    if (remainingArea === 0) return true;
    while (pos < size && !free[pos]) pos++;
    if (pos === size) return false;
    if (deadCells(pos, slack) > slack) return false;

    const r = Math.floor(pos / cols);
    const c = pos % cols;
    for (const type of types) {
      if (type.count === 0) continue;
      for (const orientation of type.orientations) {
        const cells = fit(r, c, orientation);
        if (!cells) continue;
        cells.forEach((cell) => (free[cell] = 0));
        type.count--;
        remainingArea -= type.area;
        placed.push({ type, cells });
        if (place(pos + 1, slack)) return true;
        placed.pop();
        type.count++;
        remainingArea += type.area;
        cells.forEach((cell) => (free[cell] = 1));
      }
    }

    // Leave this cell empty
    if (slack > 0) {
      free[pos] = 0;
      if (place(pos + 1, slack - 1)) return true;
      free[pos] = 1;
    }
    return false;
  };

  if (!place(0, freeCells - remainingArea)) return null;
  return new Map(placed.map(({ type, cells }) => [type.items.pop()!, cells]));
};

const groupByShape = (pieces: PackedItem[]): PieceType[] => {
  const types = new Map<string, PieceType>();
  for (const item of pieces) {
    const rotations = [0, 90, 180, 270].map((rotation) =>
      rotateShape(item.shape, rotation),
    );
    const key = rotations.map(encodeShape).sort()[0];
    let type = types.get(key);
    if (!type) {
      const distinct = new Map(rotations.map((s) => [encodeShape(s), s]));
      type = {
        area: countCells(item.shape),
        orientations: [...distinct.values()].map(toOrientation),
        items: [],
        count: 0,
      };
      types.set(key, type);
    }
    type.items.push(item);
    type.count++;
  }
  return [...types.values()];
};

const toOrientation = (shape: number[][]): Orientation => {
  const cells = shapeCells(shape);
  const [r0, c0] = cells[0];
  return {
    dr: cells.map(([r]) => r - r0),
    dc: cells.map(([, c]) => c - c0),
  };
};

// The cells an item covers at its previous rotation + topLeft, if they're all still free
const cellsAtHint = (
  item: PackedItem,
  free: Uint8Array,
  rows: number,
  cols: number,
): number[] | null => {
  if (item.rotation === undefined || item.topLeft === undefined) return null;
  if (![0, 90, 180, 270].includes(item.rotation)) return null;
  const [top, left] = item.topLeft;
  const cells: number[] = [];
  for (const [r, c] of shapeCells(rotateShape(item.shape, item.rotation))) {
    const row = top + r;
    const col = left + c;
    if (row < 0 || row >= rows || col < 0 || col >= cols) return null;
    if (!free[row * cols + col]) return null;
    cells.push(row * cols + col);
  }
  return cells;
};

// Recovers the rotation + topLeft that put this item's own shape on these cells
const toPlacement = (item: PackedItem, cells: number[], cols: number) => {
  const target = cells.map((cell): [number, number] => [
    Math.floor(cell / cols),
    cell % cols,
  ]);
  for (const rotation of [0, 90, 180, 270]) {
    const own = shapeCells(rotateShape(item.shape, rotation));
    if (normalize(own) === normalize(target)) {
      const topLeft: [number, number] = [
        Math.min(...target.map(([r]) => r)) - Math.min(...own.map(([r]) => r)),
        Math.min(...target.map(([, c]) => c)) -
          Math.min(...own.map(([, c]) => c)),
      ];
      return { rotation, topLeft };
    }
  }
  throw new Error(`No rotation of ${item.itemId} covers its placement`);
};

const normalize = (cells: [number, number][]) => {
  const minRow = Math.min(...cells.map(([r]) => r));
  const minCol = Math.min(...cells.map(([, c]) => c));
  return cells
    .map(([r, c]) => `${r - minRow},${c - minCol}`)
    .sort()
    .join(' ');
};

// Filled cells in reading order
const shapeCells = (shape: number[][]) => {
  const cells: [number, number][] = [];
  shape.forEach((row, r) =>
    row.forEach((cell, c) => {
      if (cell === 1) cells.push([r, c]);
    }),
  );
  return cells;
};

const countCells = (shape: number[][]) =>
  shape.flat().reduce((sum, cell) => sum + cell, 0);

const encodeShape = (shape: number[][]) =>
  shape.map((row) => row.join('')).join('/');

// Rotates a shape clockwise in 90-degree steps
const rotateShape = (shape: number[][], rotation: number): number[][] => {
  let rotatedShape = shape;
  for (let i = 0; i < rotation / 90; i++) {
    rotatedShape = rotatedShape[0].map((_, i) =>
      rotatedShape.map((row) => row[i]).reverse(),
    );
  }
  return rotatedShape;
};
