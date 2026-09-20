const $ = (id) => document.getElementById(id);
const show = (t) => { $("out").textContent = t; };

chrome.storage.local.get({ supabaseUrl: "", anonKey: "", token: "", enabled: false, status: null }).then((c) => {
  $("enabled").checked = c.enabled;
  if (c.token) $("code").value = JSON.stringify({ url: c.supabaseUrl, anonKey: c.anonKey, token: c.token });
  if (c.status) show("Last activity: " + new Date(c.status.at).toLocaleString() + "\n" + JSON.stringify(c.status));
});

$("save").addEventListener("click", async () => {
  let cfg;
  try { cfg = JSON.parse($("code").value); } catch (e) { return show("That is not valid connection code. Copy it again from the Setup page."); }
  if (!cfg.url || !cfg.anonKey || !cfg.token) return show("Connection code is missing url, anonKey or token.");
  await chrome.storage.local.set({ supabaseUrl: cfg.url, anonKey: cfg.anonKey, token: cfg.token, enabled: $("enabled").checked });
  show("Saved. Testing connection...");
  chrome.runtime.sendMessage({ type: "ping" }, (r) => {
    if (!r || !r.ok) return show("Could not connect: " + (r && r.error));
    const d = r.data;
    show("Connected.\nPaused: " + d.paused + "\nHalted: " + (d.halt ? d.halt.reason : "no") +
         "\nLast capture in database: " + (d.last_fetch || "none yet") + "\nScheduled loads today: " + d.jobs_today);
  });
});
