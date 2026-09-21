import { dateOnly, valuationSource } from "@/lib/format";

// Where a valuation came from and the day it was saved. Blank when the lot has no estimate.
export default function ValuationCell({ l }: { l: { est_sources?: string | null; est_updated?: string | null } }) {
  if (!l.est_updated) return <span className="neg">-</span>;
  const s = valuationSource(l.est_sources);
  return (
    <>
      {s ? (
        s.href ? (
          <a href={s.href} target="_blank" rel="noopener noreferrer" title={s.title}>{s.label}</a>
        ) : (
          <span title={s.title}>{s.label}</span>
        )
      ) : (
        <span className="neg">no source noted</span>
      )}
      {s && s.more > 0 ? <span className="neg"> +{s.more}</span> : null}
      <span className="sub">{dateOnly(l.est_updated)}</span>
    </>
  );
}
