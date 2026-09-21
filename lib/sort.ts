// Column sorting for lot tables: which column, which direction, and what a click on a heading does.
export const SORT_KEYS = [
  "ends", "bid", "bids", "bidders", "source", "name", "category",
  "worst", "worst_gap", "worst_room", "worst_roi", "base", "base_gap", "base_room", "base_roi", "best", "best_gap", "best_room", "best_roi",
];

// Addresses saved before the three cases existed: the low estimate is now the worst case.
const LEGACY: Record<string, string> = { estimate: "worst", gap: "worst_gap", room: "worst_room", max: "worst_room" };

export const defaultDir = (key: string) => (key === "ends" || key === "name" || key === "category" ? "asc" : "desc");

export function readSort(rawSort: string, rawDir: string) {
  const wanted = LEGACY[rawSort] ?? rawSort;
  const sort = SORT_KEYS.includes(wanted) ? wanted : "ends";
  const dir = rawDir === "asc" || rawDir === "desc" ? rawDir : defaultDir(sort);
  return { sort, dir };
}

// Clicking the active column flips it; clicking another column starts in that column's natural direction.
export const nextDir = (active: string, dir: string, key: string) =>
  key === active ? (dir === "asc" ? "desc" : "asc") : defaultDir(key);
