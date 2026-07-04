export type JumpEdge = "top" | "bottom";

export function jumpIndex(rowCount: number, edge: JumpEdge): number {
  if (rowCount <= 0) {
    return 0;
  }
  return edge === "top" ? 0 : rowCount - 1;
}

export function jumpScrollOffset(totalRows: number, height: number, edge: JumpEdge): number {
  if (edge === "top") {
    return 0;
  }
  return Math.max(0, totalRows - Math.max(1, height));
}
