/** Minimal terminal table (ASCII). Cells are stringified; width by String length. */

export type TableAlign = "left" | "right";

export type TableColumn = {
  key: string;
  header: string;
  align?: TableAlign;
  minWidth?: number;
};

function cellWidth(s: string): number {
  // Basic width: treat each code unit as 1 (good enough for ASCII % tables).
  return [...s].length;
}

function padCell(s: string, width: number, align: TableAlign): string {
  const w = cellWidth(s);
  if (w >= width) return s;
  const pad = " ".repeat(width - w);
  return align === "right" ? pad + s : s + pad;
}

/**
 * Render a GitHub-flavored-markdown-like table that looks clean in terminals:
 *
 * | a | b |
 * |---|---|
 * | 1 | 2 |
 */
export function formatMarkdownTable(
  columns: TableColumn[],
  rows: Array<Record<string, string | number | null | undefined>>,
): string {
  const headers = columns.map((c) => c.header);
  const data = rows.map((row) =>
    columns.map((c) => {
      const v = row[c.key];
      if (v == null) return "-";
      if (v === "") return "";
      return String(v);
    }),
  );

  const widths = columns.map((c, i) => {
    let w = Math.max(c.minWidth ?? 0, cellWidth(c.header));
    for (const r of data) w = Math.max(w, cellWidth(r[i] ?? ""));
    return w;
  });

  const line = (cells: string[], align: TableAlign[] = columns.map((c) => c.align ?? "left")) =>
    `| ${cells.map((cell, i) => padCell(cell, widths[i]!, align[i] ?? "left")).join(" | ")} |`;

  const sep = `| ${widths.map((w, i) => {
    const a = columns[i]?.align ?? "left";
    if (a === "right") return "-".repeat(Math.max(3, w - 1)) + ":";
    return "-".repeat(Math.max(3, w));
  }).join(" | ")} |`;

  const out = [line(headers), sep];
  for (const r of data) out.push(line(r));
  return out.join("\n");
}
