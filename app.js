const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const NS = "http://www.w3.org/2000/svg";
const icon = (n, cls = "") => { const s = document.createElementNS(NS, "svg"); s.setAttribute("class", `ic ${cls}`); s.innerHTML = `<use href="#i-${n}"/>`; return s; };
const h = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.filter((k) => k != null)); return e; };
const store = chrome.storage.local;
const when = (iso) => { const d = new Date(iso); return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) + " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); };
const hue = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
const art = (name) => h("div", { className: "art" }, icon("capture"));
const tint = (el, name) => (el.style.setProperty("--h", hue(name)), el);

let S = { method: "direct", clientId: "", max: 100, onboarded: false };
let lib = [], job = null, cap = null, openId = null, view = "capture";
const VIEWS = ["capture", "library", "settings"];

function toast(msg, kind = "") {
  const t = h("div", { className: `toast ${kind}` }, icon(kind === "err" ? "warn" : "check"), msg);
  $("#toasts").append(t);
  setTimeout(() => t.classList.add("out"), kind === "err" ? 5000 : 2600);
  setTimeout(() => t.remove(), kind === "err" ? 5500 : 3100);
}
const saveSettings = () => store.set({ settings: S });

function show(v) {
  view = v;
  $$(".view").forEach((s) => (s.hidden = s.id !== v));
  $$("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  $("#tabs").style.setProperty("--i", Math.max(0, VIEWS.indexOf(v)));
  if (v === "library") { openId = null; renderLibrary(); }
  if (v === "capture") refreshSource();
  if (v === "settings") { $("#clientId").value = S.clientId; $("#st-max").value = S.max; paintMethod(); }
}
$$("#tabs button").forEach((b) => (b.onclick = () => show(b.dataset.v)));

/* ---------- Spotify method (onboarding + settings) ---------- */
function paintMethod() {
  $$(".seg.method").forEach((seg) => {
    seg.style.setProperty("--i", S.method === "api" ? 1 : 0);
    $$("button", seg).forEach((b) => b.classList.toggle("on", b.dataset.m === S.method));
  });
  $$(".api-only").forEach((e) => (e.hidden = S.method !== "api"));
  $$(".direct-only").forEach((e) => (e.hidden = S.method !== "direct"));
}
$$(".seg.method button").forEach((b) => (b.onclick = () => { S.method = b.dataset.m; paintMethod(); saveSettings(); }));
$$(".redirect").forEach((e) => { e.textContent = chrome.identity.getRedirectURL(); e.onclick = () => navigator.clipboard.writeText(e.textContent).then(() => toast("Copied")); });
$("#ob-go").onclick = async () => {
  S.clientId = $("#ob-client").value.trim(); S.onboarded = true;
  await saveSettings(); $("#tabs").hidden = false; show("capture");
};
$("#clientId").onchange = () => { S.clientId = $("#clientId").value.trim(); saveSettings(); toast("Saved"); };
$("#st-reset").onclick = async () => { await chrome.storage.session.remove("token"); toast("Spotify login cleared"); };

$$(".stepper").forEach((st) => {
  const inp = $("input", st);
  $$("button", st).forEach((b) => (b.onclick = () => { inp.value = Math.min(500, Math.max(1, (+inp.value || 100) + +b.dataset.d)); inp.dispatchEvent(new Event("change")); }));
  inp.onchange = () => { S.max = Math.min(500, Math.max(1, +inp.value || 100)); $("#max").value = $("#st-max").value = S.max; saveSettings(); };
});

/* ---------- capture ---------- */
async function refreshSource() {
  const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/*", "https://music.youtube.com/*"] });
  tabs.sort((a, b) => (/list=/.test(b.url) - /list=/.test(a.url)) || (b.lastAccessed - a.lastAccessed));
  const t = tabs[0];
  $("#src-dot").classList.toggle("on", !!t);
  $("#src-text").textContent = t ? t.title.replace(/ - YouTube( Music)?$/, "") : "No YouTube tab open";
}
$("#rescan").onclick = refreshSource;
$("#go").onclick = () => {
  chrome.runtime.sendMessage({ type: "capture", name: $("#pname").value.trim(), max: +$("#max").value || S.max });
  $("#pname").value = "";
};
function renderCap() {
  const el = $("#cap");
  el.className = `status ${cap?.state === "ok" ? "ok" : cap?.state === "err" ? "err" : ""}`;
  el.replaceChildren();
  if (cap) el.append(cap.state === "run" ? h("span", { className: "spin" }) : icon(cap.state === "ok" ? "check" : "warn"), cap.msg);
  $("#go").disabled = cap?.state === "run";
}

/* ---------- library ---------- */
const csvEsc = (s) => `"${String(s).replace(/"/g, '""')}"`;
function exportCsv(e) {
  const csv = "\uFEFFArtist,Title\r\n" + e.tracks.map((t) => `${csvEsc(t.artist)},${csvEsc(t.title)}`).join("\r\n");
  const a = h("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })), download: `${e.name.replace(/[^\w\- ]+/g, "").trim().slice(0, 60) || "mix"} ${e.date.slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove();
}
function sendSpotify(e) {
  if (job?.state === "run") return toast("A Spotify job is already running", "err");
  if (S.method === "api" && !S.clientId) return toast("Add your Client ID in Settings first", "err");
  chrome.runtime.sendMessage({ type: S.method, entryId: e.id });
}
const trackRow = (t, i) => h("div", { className: "trk" }, h("i", { textContent: i + 1 }), h("div", {}, h("b", { textContent: t.title }), h("small", { textContent: t.artist })));

function renderLibrary() {
  $("#lib-list").hidden = !!openId; $("#lib-detail").hidden = !openId;
  if (openId) return renderDetail();
  const q = $("#q").value.trim().toLowerCase(), box = $("#lib");
  box.replaceChildren();
  let n = 0;
  if (!q) {
    const card = h("div", { className: "card" });
    lib.forEach((e) => {
      const row = h("button", { className: "row" }, tint(art(e.name), e.name),
        h("div", { className: "rt" }, h("b", { textContent: e.name }), h("small", { textContent: `${when(e.date)} · ${e.tracks.length} songs` })),
        e.spotifyUrl ? h("span", { className: "badge", textContent: "On Spotify" }) : null, icon("chev", "chev"));
      row.style.setProperty("--d", n++ % 14);
      row.onclick = () => { openId = e.id; renderLibrary(); };
      card.append(row);
    });
    if (lib.length) box.append(card);
  } else {
    lib.forEach((e) => {
      const hits = e.tracks.filter((t) => `${t.artist} ${t.title} ${e.name}`.toLowerCase().includes(q));
      if (!hits.length) return;
      n++;
      box.append(h("p", { className: "sec", textContent: `${e.name} · ${when(e.date)}` }), h("div", { className: "card" }, ...hits.map(trackRow)));
    });
    if (!n) box.append(h("div", { className: "empty", textContent: "Nothing matches that search." }));
    return;
  }
  if (!lib.length) box.append(h("div", { className: "empty", textContent: "Your library is empty. Capture a mix to get started." }));
}
$("#q").oninput = renderLibrary;

function renderDetail() {
  const e = lib.find((x) => x.id === openId);
  if (!e) { openId = null; return renderLibrary(); }
  const back = h("button", { className: "back" }, icon("back"), "Library");
  back.onclick = () => { openId = null; renderLibrary(); };
  const hero = h("div", { className: "hero" }, tint(art(e.name), e.name),
    h("div", {}, h("h2", { textContent: e.name }), h("p", { textContent: `${when(e.date)} · ${e.tracks.length} songs` })));
  const add = h("button", { className: "btn primary" }, icon("send"), e.spotifyUrl ? "Add to Spotify again" : "Add to Spotify");
  add.onclick = () => sendSpotify(e);
  const exp = h("button", { className: "btn" }, icon("export"), "Export CSV");
  exp.onclick = () => exportCsv(e);
  const del = h("button", { className: "btn danger" }, icon("trash"), "Delete");
  let armed = false;
  del.onclick = async () => {
    if (!armed) { armed = true; del.lastChild.textContent = "Tap again to delete"; return void setTimeout(() => { armed = false; del.lastChild.textContent = "Delete"; }, 3000); }
    lib = lib.filter((x) => x.id !== e.id); await store.set({ library: lib }); openId = null; renderLibrary();
  };
  const actions = h("div", { className: "actions" }, add, exp, del);
  if (e.spotifyUrl) actions.append(h("a", { className: "btn", href: e.spotifyUrl, target: "_blank" }, icon("link"), "Open on Spotify"));
  $("#lib-detail").replaceChildren(back, hero, actions, h("div", { className: "card" }, ...e.tracks.map(trackRow)));
}

/* ---------- Spotify progress sheet ---------- */
function renderSheet() {
  $("#sheet").classList.toggle("open", !!job);
  if (!job) return;
  const running = job.state === "run";
  $("#sh-title").textContent = { run: "Adding to Spotify", done: "All done", cancelled: "Cancelled", error: "Couldn't finish" }[job.state] || "Spotify";
  const sub = $("#sh-sub");
  sub.className = `hint ${job.state === "error" ? "err" : ""}`;
  sub.textContent = job.state === "error" ? job.error : `${job.name}${job.total ? ` · ${job.i} of ${job.total}` : ""}`;
  $("#sh-bar").style.width = `${job.state === "done" ? 100 : job.total ? Math.max(4, (job.i / job.total) * 100) : 4}%`;
  const ICONS = { ok: "check", fail: "x", warn: "warn" };
  $("#sh-steps").replaceChildren(...job.log.slice(-7).map((l) =>
    h("li", {}, l.state === "run" ? h("span", { className: "spin" }) : icon(ICONS[l.state] || "check", l.state), h("span", { textContent: l.text }))));
  const parts = [job.added && `${job.added} added`, job.dup && `${job.dup} already there`, job.missed.length && `${job.missed.length} not found`, job.failed.length && `${job.failed.length} failed`].filter(Boolean);
  $("#sh-sum").textContent = parts.join(" · ");
  const open = $("#sh-open");
  open.hidden = !job.url || running; if (job.url) open.href = job.url;
  const main = $("#sh-main");
  main.textContent = running ? "Cancel" : "Done";
  main.className = running ? "btn danger" : "btn primary";
}
$("#sh-main").onclick = () => (job?.state === "run" ? chrome.runtime.sendMessage({ type: "cancel" }) : store.remove("job"));

/* ---------- live updates + boot ---------- */
chrome.storage.onChanged.addListener((c, area) => {
  if (area !== "local") return;
  if (c.library) { lib = c.library.newValue || []; if (view === "library") renderLibrary(); }
  if (c.job) { job = c.job.newValue || null; renderSheet(); }
  if (c.capture) { const prev = cap; cap = c.capture.newValue || null; renderCap(); if (prev?.state === "run" && cap?.state === "ok") toast(cap.msg); }
});

(async () => {
  const d = await store.get(["settings", "library", "job", "capture"]);
  S = { ...S, ...d.settings }; lib = d.library || []; job = d.job || null; cap = d.capture || null;
  if (cap?.state === "run" && Date.now() - cap.at > 90000) cap = null;
  $("#max").value = $("#st-max").value = S.max;
  $("#ob-client").value = S.clientId;
  paintMethod(); renderSheet(); renderCap();
  $("#tabs").hidden = !S.onboarded;
  show(S.onboarded ? "capture" : "onboard");
})();
