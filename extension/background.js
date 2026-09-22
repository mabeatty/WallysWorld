// EBTH Watch background worker. Every minute it asks your database what to load next, loads it
// in a background tab of THIS browser (your normal, logged-in session), and reports what it saw.
// The database decides pacing, quiet hours, daily cap, and halts on any block or logout.
importScripts("lib/ebth.js");

const JOB_TIMEOUT_MS = 90000;
const LIST_JOB_TIMEOUT_MS = 120000;   // a list page can take up to 40s for its lots to appear
const CATAWIKI_JOB_TIMEOUT_MS = 60000; // Catawiki pages are server-rendered with everything already
                                        // present -- no DOM-polling wait, so a shorter timeout suffices
                                        // for either job kind

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("tick", { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("tick", { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "tick") tick().catch(logError); });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));


async function closeJobSurface(pending) {
  try { await chrome.tabs.remove(pending.tabId); } catch (e) {}
}
const getCfg = () => chrome.storage.local.get({ supabaseUrl: "", anonKey: "", token: "", enabled: false });
const getPending = async () => (await chrome.storage.session.get("pending")).pending || null;
const clearPending = () => chrome.storage.session.remove("pending");
const setStatus = (s) => chrome.storage.local.set({ status: Object.assign({ at: Date.now() }, s) });
function logError(e) { setStatus({ error: String(e && e.message || e) }); }

async function rpc(name, body) {
  const c = await getCfg();
  const headers = { "Content-Type": "application/json", apikey: c.anonKey };
  if (c.anonKey.indexOf("eyJ") === 0) headers.Authorization = "Bearer " + c.anonKey;
  const r = await fetch(c.supabaseUrl.replace(/\/$/, "") + "/rest/v1/rpc/" + name,
    { method: "POST", headers: headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(name + " failed: " + r.status + " " + (await r.text()).slice(0, 200));
  return r.json();
}

async function tick() {
  const c = await getCfg();
  if (!c.token || !c.enabled) return;
  const pending = await getPending();
  if (pending) {
    const timeout = pending.platform === "catawiki" ? CATAWIKI_JOB_TIMEOUT_MS
      : (pending.job.kind === "list" ? LIST_JOB_TIMEOUT_MS : JOB_TIMEOUT_MS);
    if (Date.now() - pending.startedAt < timeout) return;
    return failPending(pending, c);
  }

  // One combined pending-job slot for both platforms, same as the shared pacing budget they draw
  // against. EBTH's next_job almost always has something to do, so trying it first every tick
  // would starve Catawiki entirely; flip which platform goes first each tick instead, and only
  // fall through to the other if the preferred one has nothing -- never dispatch from both in one
  // tick.
  const { catawikiTurn } = await chrome.storage.local.get({ catawikiTurn: false });
  await chrome.storage.local.set({ catawikiTurn: !catawikiTurn });
  let job = null, platform = null;
  if (catawikiTurn) {
    job = await rpc("catawiki_next_job", { p_token: c.token });
    if (job) platform = "catawiki";
    else { job = await rpc("next_job", { p_token: c.token }); platform = "ebth"; }
  } else {
    job = await rpc("next_job", { p_token: c.token });
    if (job) platform = "ebth";
    else { job = await rpc("catawiki_next_job", { p_token: c.token }); platform = "catawiki"; }
  }
  if (!job) { await setStatus({ idle: true }); return; }
  await sleep(Math.random() * 15000);                       // small random spacing on top of the server's minimum gap
  const tab = await chrome.tabs.create({ url: job.url, active: false });
  await chrome.storage.session.set({ pending: { tabId: tab.id, job: job, platform: platform, startedAt: Date.now() } });
}

async function failPending(pending, c) {
  let verdict = "unexpected", note = "page did not report back";
  try {
    const tab = await chrome.tabs.get(pending.tabId);
    // Catawiki's lot/auction pages are public -- no sign-in wall to land on -- so this check is
    // EBTH-specific; a Catawiki failure just keeps the default "unexpected" verdict above.
    if (pending.platform === "ebth" && /login|sign_in|sessions/i.test(tab.url || "")) {
      verdict = "logged_out"; note = "redirected to sign-in";
    }
  } catch (e) { note = "tab closed before the page reported"; }
  const j = pending.job;
  if (pending.platform === "catawiki") {
    await rpc("catawiki_ingest_page", { p_token: c.token, p: {
      kind: j.kind, url: j.url, verdict: verdict, note: note, source: "job",
      item_id: j.item_id || null, seed_name: j.seed_name || null, auction: null, lots: [] } });
  } else {
    await rpc("ingest_page", { p_token: c.token, p: {
      kind: j.kind === "list" ? "list" : "lot", url: j.url, verdict: verdict, note: note, items: [], lot: null,
      job: { kind: j.kind, url: j.url, item_id: j.item_id } } });
  }
  await clearPending();
  await closeJobSurface(pending);
  await setStatus({ lastVerdict: verdict, note: note, platform: pending.platform });
}

async function handleCapture(payload, tabId) {
  const c = await getCfg();
  if (!c.token) return;
  const pending = await getPending();
  const job = pending && pending.tabId === tabId ? pending.job : null;
  const v = EBTH.verdictFrom(payload.sig, !!(job && job.requires_login));
  const ok = v[0] === "ok";
  const res = await rpc("ingest_page", { p_token: c.token, p: {
    kind: payload.kind, url: payload.url, verdict: v[0], note: v[1] || (payload.diag || "").slice(0, 280),
    diag: payload.diag || null,
    items: ok ? payload.items : [], lot: ok ? payload.lot : null,
    sale: ok ? payload.sale : null, pages: payload.pages || 1,
    job: job ? { kind: job.kind, url: job.url, item_id: job.item_id } : null } });
  if (job) {
    await clearPending();
    await closeJobSurface(pending);
  }
  await setStatus({ lastCapture: Date.now(), lastVerdict: v[0], halted: !!(res && res.halted), source: job ? "job" : "passive" });
}

async function handleCatawikiCapture(payload, tabId) {
  const c = await getCfg();
  if (!c.token) return;
  const pending = await getPending();
  const job = pending && pending.tabId === tabId && pending.platform === "catawiki" ? pending.job : null;
  await rpc("catawiki_ingest_page", { p_token: c.token, p: {
    kind: payload.kind, url: payload.url, verdict: payload.verdict, note: payload.note,
    source: job ? "job" : "passive",
    item_id: job ? job.item_id || null : null, seed_name: job ? job.seed_name || null : null,
    auction: payload.auction, lots: payload.lots } });
  if (job) {
    await clearPending();
    await closeJobSurface(pending);
  }
  await setStatus({ lastCapture: Date.now(), lastVerdict: payload.verdict, source: job ? "job" : "passive", platform: "catawiki" });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "whoami") {
    getPending().then((p) => sendResponse({
      job: !!(p && sender.tab && p.tabId === sender.tab.id), kind: p && p.job && p.job.kind,
      hint: p && p.job ? p.job.hint || null : null }));
    return true;
  }
  if (msg.type === "capture" && sender.tab) {
    handleCapture(msg.payload, sender.tab.id).then(() => sendResponse({ ok: true }))
      .catch((e) => { logError(e); sendResponse({ ok: false }); });
    return true;
  }
  if (msg.type === "catawiki_capture" && sender.tab) {
    handleCatawikiCapture(msg.payload, sender.tab.id).then(() => sendResponse({ ok: true }))
      .catch((e) => { logError(e); sendResponse({ ok: false }); });
    return true;
  }
  if (msg.type === "ping") {
    getCfg().then((c) => rpc("ping", { p_token: c.token })).then((r) => sendResponse({ ok: true, data: r }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
});
