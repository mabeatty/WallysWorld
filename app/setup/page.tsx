import Link from "next/link";
import { rpc, publicKeys, type BidMath } from "@/lib/supabase";
import { addSeed, removeSeed, saveBidMath } from "../actions";
import { money } from "@/lib/format";
import CopyBox from "../CopyBox";

export const dynamic = "force-dynamic";

type Seed = { name: string; url: string; requires_login: boolean; enabled: boolean };

export default async function Setup({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const flag = (k: string) => { const v = sp[k]; return (Array.isArray(v) ? v[0] : v) ?? ""; };
  const { url, anonKey } = publicKeys();
  const [setup, math] = await Promise.all([
    rpc<{ ingest_token: string; seeds: Seed[] }>("dash_setup"),
    rpc<BidMath>("dash_bid_math"),
  ]);
  const pct = (n: number) => String(Math.round(n * 1000) / 10);
  const tiers = math.tiers.map((t, i) => {
    const lo = i === 0 ? 0 : (math.tiers[i - 1].up_to ?? 0);
    const rate = `${Math.round(t.rate * 1000) / 10}%`;
    return t.up_to == null ? `${rate} above ${money(lo)}` : i === 0 ? `${rate} up to ${money(t.up_to)}` : `${rate} from ${money(lo)} to ${money(t.up_to)}`;
  }).join(", ");
  const code = JSON.stringify({ url, anonKey, token: setup.ingest_token });
  const missing = !url || !anonKey;

  return (
    <>
      <header className="top">
        <h1>Setup</h1>
        <nav className="links"><Link href="/">Dashboard</Link><Link href="/watches">Watches</Link><Link href="/lots">Find lots</Link></nav>
      </header>

      <h2 id="bidmath">Bid math</h2>
      <p className="note">Each lot&apos;s calculated max bid is the most you can pay at the hammer and still keep your margin, worked out separately for the worst, base and best case: that case&apos;s value, less the resale fee, less your margin, divided by one plus the buyer&apos;s premium.</p>
      {flag("saved") && <div className="saved" role="status">Saved. Calculated max bids now use these numbers.</div>}
      {flag("error") && <div className="banner" role="alert"><strong>Not saved</strong><p>{flag("error")}</p></div>}
      <form action={saveBidMath} className="bidmath">
        <label>Buyer&apos;s premium, %<input type="text" inputMode="decimal" name="premium" defaultValue={pct(math.premium)} /></label>
        <label>Margin to keep, %<input type="text" inputMode="decimal" name="margin" defaultValue={pct(math.margin)} /></label>
        <label>Dealer discount, %<input type="text" inputMode="decimal" name="dealer" defaultValue={pct(math.dealer)} /></label>
        <button type="submit">Save</button>
      </form>
      <p className="note">EBTH does not charge buyers a premium (per EBTH&apos;s terms), so this is set to 0%. Change it only if that changes, or to model another auction site. Resale fee, applied in tiers: {tiers}. That is eBay&apos;s watch schedule for non-store sellers as announced in 2022, not confirmed for 2026. It leaves out the per-order fee, shipping, and sales tax.</p>
      <p className="note">Dealer bid is the worst case less the dealer discount, with no resale fee, since a dealer pays outright. The 15% is a rule of thumb for liquid, mainstream watches; thinner or cheaper pieces run wider. A firm quote from a dealer replaces it.</p>

      <h2>Connect the Chrome extension</h2>
      <ol className="steps">
        <li>Get the <code>extension</code> folder from the project files and keep it somewhere permanent on the computer whose Chrome will do the collecting.</li>
        <li>In Chrome, open <code>chrome://extensions</code>, turn on Developer mode, choose Load unpacked, and select the <code>extension</code> folder.</li>
        <li>Open the extension&apos;s settings, paste the connection code below, tick the collect box, and choose Save and test.</li>
        <li>Sign in to ebth.com in that same Chrome and leave it open. It loads pages in background tabs at a slow pace and stops itself if anything looks wrong.</li>
      </ol>
      {missing && (
        <div className="banner" role="alert">
          <strong>Missing project keys</strong>
          <p>Add <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> to your Vercel environment variables, redeploy, and reload this page.</p>
        </div>
      )}
      <CopyBox value={code} />
      <p className="note" style={{ marginTop: 8 }}>This code lets the extension write to your database. Keep it private.</p>

      <h2>Pages to watch</h2>
      <p className="note">Each page is loaded on a schedule, and every lot on it is recorded. Add sale, category or search pages from ebth.com. The followed-items page needs you signed in.</p>
      <table>
        <thead><tr><th>Name</th><th>Address</th><th></th></tr></thead>
        <tbody>
          {setup.seeds.map((s) => (
            <tr key={s.name}>
              <td>{s.name}{s.requires_login ? <span className="tag"> (needs sign-in)</span> : null}</td>
              <td className="name">{s.url}</td>
              <td className="num">
                <form action={removeSeed}><input type="hidden" name="name" value={s.name} /><button className="quiet" type="submit">Remove</button></form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form action={addSeed} className="inline">
        <input type="url" name="url" placeholder="https://www.ebth.com/sales/..." required aria-label="Page address" />
        <label><input type="checkbox" name="login" /> needs sign-in</label>
        <button type="submit">Add page</button>
      </form>
    </>
  );
}
