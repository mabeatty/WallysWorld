// Column sorting for lot tables: which column, which direction, and what a click on a heading does.
const KEYS = ["ends", "bid", "estimate", "gap", "name"];

export const defaultDir = (key: string) => (key === "ends" || key === "name" ? "asc" : "desc");

export function readSort(rawSort: string, rawDir: string) {
  const sort = KEYS.includes(rawSort) ? rawSort : "ends";
  const dir = rawDir === "asc" || rawDir === "desc" ? rawDir : defaultDir(sort);
  return { sort, dir };
}

// Clicking the active column flips it; clicking another column starts in that column's natural direction.
export const nextDir = (active: string, dir: string, key: string) =>
  key === active ? (dir === "asc" ? "desc" : "asc") : defaultDir(key);
