import Link from "next/link";
import { rpc, publicKeys } from "@/lib/supabase";
import { addSeed, removeSeed } from "../actions";
import CopyBox from "../CopyBox";

export const dynamic = "force-dynamic";

type Seed = { name: string; url: string; requires_login: boolean; enabled: boolean };

export default async function Setup() {
  const { url, anonKey } = publicKeys();
  const setup = await rpc<{ ingest_token: string; seeds: Seed[] }>("dash_setup");
  const code = JSON.stringify({ url, anonKey, token: setup.ingest_token });
  const missing = !url || !anonKey;

  return (
    <>
      <header className="top">
        <h1>Setup</h1>
        <nav className="links"><Link href="/">Dashboard</Link><Link href="/lots">Find lots</Link></nav>
      </header>

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
