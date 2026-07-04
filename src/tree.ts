export interface TreeNode {
  name: string;
  path: string;
  type: "dir" | "file";
  children: TreeNode[];
}

export interface VisibleRow {
  node: TreeNode;
  name: string;
  path: string;
  type: "dir" | "file";
  depth: number;
  expanded: boolean;
}

export function buildTree(paths: string[]): TreeNode {
  const root = createNode("", "", "dir");

  for (const rawPath of paths) {
    const parts = rawPath.split("/").filter((part) => part.length > 0);
    if (parts.length === 0) {
      continue;
    }

    let current = root;
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      if (name === undefined) {
        continue;
      }

      const isLast = index === parts.length - 1;
      const path = current.path.length === 0 ? name : `${current.path}/${name}`;
      const type = isLast ? "file" : "dir";
      let child = current.children.find((candidate) => candidate.name === name && candidate.type === type);
      if (child === undefined) {
        child = createNode(name, path, type);
        current.children.push(child);
      }

      current = child;
    }
  }

  sortTree(root);
  return root;
}

export function flattenTree(root: TreeNode, isExpanded: (path: string, depth: number) => boolean): VisibleRow[] {
  const rows: VisibleRow[] = [];
  appendVisibleRows(root, isExpanded, rows, -1);
  return rows;
}

export function compareTreeNodes(left: TreeNode, right: TreeNode): number {
  if (left.type !== right.type) {
    return left.type === "dir" ? -1 : 1;
  }
  return left.name.localeCompare(right.name);
}

export function findVisibleParentDirIndex(rows: readonly VisibleRow[], rowIndex: number): number {
  const row = rows[rowIndex];
  if (row === undefined) {
    return -1;
  }

  const lastSlash = row.path.lastIndexOf("/");
  if (lastSlash === -1) {
    return -1;
  }

  const parentPath = row.path.slice(0, lastSlash);
  return rows.findIndex((candidate) => candidate.type === "dir" && candidate.path === parentPath);
}

function createNode(name: string, path: string, type: "dir" | "file"): TreeNode {
  return { name, path, type, children: [] };
}

function sortTree(node: TreeNode): void {
  node.children.sort(compareTreeNodes);

  for (const child of node.children) {
    sortTree(child);
  }
}

function appendVisibleRows(
  node: TreeNode,
  isExpanded: (path: string, depth: number) => boolean,
  rows: VisibleRow[],
  parentDepth: number,
): void {
  for (const child of node.children) {
    const depth = parentDepth + 1;
    const expanded = child.type === "dir" && isExpanded(child.path, depth);
    rows.push({
      node: child,
      name: child.name,
      path: child.path,
      type: child.type,
      depth,
      expanded,
    });

    if (expanded) {
      appendVisibleRows(child, isExpanded, rows, depth);
    }
  }
}
