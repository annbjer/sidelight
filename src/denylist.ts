export function isDenied(relPath: string): boolean {
  const segments = relPath.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === ".git" || segment === "node_modules")) {
    return true;
  }

  const basename = segments.at(-1) ?? "";
  if (basename === ".DS_Store") {
    return true;
  }

  return (
    basename.startsWith(".env") ||
    basename.endsWith(".pem") ||
    basename.endsWith(".key") ||
    basename.includes("_rsa")
  );
}
