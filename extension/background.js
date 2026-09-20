// EBTH Watch background worker. Every minute it asks your database what to load next, loads it
// in a background tab of THIS browser (your normal, logged-in session), and reports what it saw.
// The database decides pacing, quiet hours, daily cap, and halts on any block or logout.
importScripts("lib/ebth.js");

const JOB_TIMEOUT_MS = 90000;
const LIST_JOB_TIMEOUT_MS = 120000;   // a list page can take up to 40s for its lots to appear

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
    if (Date.now() - pending.startedAt < (pending.job.kind === "list" ? LIST_JOB_TIMEOUT_MS : JOB_TIMEOUT_MS)) return;
    return failPending(pending, c);
  }
  const job = await rpc("next_job", { p_token: c.token });
  if (!job) { await setStatus({ idle: true }); return; }
  await sleep(Math.random() * 15000);                       // small random spacing on top of the server's minimum gap
  const tab = await chrome.tabs.create({ url: job.url, active: false });
  await chrome.storage.session.set({ pending: { tabId: tab.id, job: job, startedAt: Date.now() } });
}

async function failPending(pending, c) {
  let verdict = "unexpected", note = "page did not report back";
  try {
    const tab = await chrome.tabs.get(pending.tabId);
    if (/login|sign_in|sessions/i.test(tab.url || "")) { verdict = "logged_out"; note = "redirected to sign-in"; }
  } catch (e) { note = "tab closed before the page reported"; }
  const j = pending.job;
  await rpc("ingest_page", { p_token: c.token, p: {
    kind: j.kind === "list" ? "list" : "lot", url: j.url, verdict: verdict, note: note, items: [], lot: null,
    job: { kind: j.kind, url: j.url, item_id: j.item_id } } });
  await clearPending();
  await closeJobSurface(pending);
  await setStatus({ lastVerdict: verdict, note: note });
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
  if (msg.type === "ping") {
    getCfg().then((c) => rpc("ping", { p_token: c.token })).then((r) => sendResponse({ ok: true, data: r }))
      .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
});
