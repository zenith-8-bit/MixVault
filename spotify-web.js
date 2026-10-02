// "Direct" method v2: drives the signed-in Spotify web player (no API, no developer app).
// New flow: create playlist -> name it -> press "Add" on the playlist page, which opens the
// "Add to playlist" side panel -> for each song: type the search, press the (+) on the first
// result. Everything happens on one page (no per-song navigation or context menus).
// Every step is performed, then VERIFIED from the page before the next one starts.
import { ctl, J, startJob, patch, note, save } from "./job.js";

const HOME = "https://open.spotify.com/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class StepError extends Error {}
class Cancelled extends Error {}

/* ---- runs INSIDE the Spotify page; one small operation per call ---- */
async function pageOp(op, a) {
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const txt = (e) => ((e && (e.innerText || e.textContent)) || "").replace(/\s+/g, " ").trim();
  const vis = (e) => !!e && (e.offsetParent !== null || e.getClientRects().length > 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const wait = async (fn, ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await sleep(120); } return null; };
  const byText = (sel, re, root = document) => $$(sel, root).find((e) => vis(e) && re.test(txt(e)));
  const click = (e) => { e.scrollIntoView?.({ block: "nearest" }); e.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); e.click(); };
  const setValue = (el, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); };
  const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="menu"] button, [role="menu"] li';

  // The "Add to playlist" side panel: the tall, narrow block holding that heading and a search box.
  const findPanel = () => {
    const head = $$("h1, h2, h3, h4, span, div, p").find((e) => !e.children.length && vis(e) && /^add to playlist$/i.test(txt(e)));
    for (let p = head; p && p !== document.body; p = p.parentElement) {
      const r = p.getBoundingClientRect();
      if (p.querySelector("input") && r.height > innerHeight * 0.5 && r.width < innerWidth * 0.55) return p;
    }
    return null;
  };
  // Result rows = the small icon-only (+) buttons under the search box, with the row's text.
  const rows = (panel) => {
    const input = panel.querySelector("input");
    const below = input.getBoundingClientRect().bottom + 4;
    const bs = $$("button", panel).filter((b) =>
      vis(b) && b.querySelector("svg") && txt(b).length <= 20 && b.getBoundingClientRect().top > below &&
      !/close|clear|next|previous|scroll|more options|search/i.test(b.getAttribute("aria-label") || ""))
      .sort((x, y) => x.getBoundingClientRect().top - y.getBoundingClientRect().top);
    return bs.map((b) => {
      let el = b;
      for (let k = 0; k < 6; k++) {
        const par = el.parentElement;
        if (!par || par.contains(input) || bs.filter((c) => par.contains(c)).length !== 1) break;
        el = par;
      }
      const lines = (el.innerText || "").split("\n").map((s) => s.trim()).filter((s) => s.length > 1);   // drops the "E" badge
      return { b, info: { title: lines[0] || "", artist: lines.slice(1).join(", "), key: lines.join("|") } };
    }).filter((r) => r.info.title && !/suggested (songs|episodes)/i.test(r.info.key));
  };

  switch (op) {
    case "status": {
      const loginBtn = !!document.querySelector('[data-testid="login-button"]') || !!byText("button, a", /^log in$/i);
      const appUi = !!document.querySelector('[data-testid="user-widget-link"], [data-testid="create-playlist-button"], nav[aria-label="Main"], [aria-label="Your Library"]') || !!byText("button", /^create$/i);
      const m = location.pathname.match(/^\/playlist\/([A-Za-z0-9]+)/);
      return {
        ready: document.readyState === "complete" && !!document.querySelector("#main, main, [data-testid='main']"),
        loggedIn: appUi && !loginBtn, path: location.pathname, playlistId: m ? m[1] : null,
      };
    }
    case "createPlaylist": {
      const btn = document.querySelector('[data-testid="create-playlist-button"], button[aria-label="Create playlist or folder"], button[aria-label="Create"]') || byText("button", /^\s*create\s*$/i);
      if (!btn) return { ok: false, error: "Create button not found" };
      click(btn);
      const item = await wait(() => byText(ITEMS, /^playlist\b/i), 4000);
      if (item) { click(item); return { ok: true }; }
      if (/^\/playlist\//.test(location.pathname)) return { ok: true };
      return { ok: false, error: "Playlist option not found in the Create menu" };
    }
    case "readPlaylist": {
      const title = txt(document.querySelector('[data-testid="entityTitle"] h1, h1'));
      const head = (document.querySelector("main") || document.body).innerText.slice(0, 900);
      const loaded = !!title && /playlist/i.test(head);                       // "Public Playlist" label is in the header
      const m = head.match(/(\d[\d,]*)\s+songs?\b/i);
      return { title, songs: !loaded ? null : m ? +m[1].replace(/,/g, "") : 0 };   // header only shows a count once it has songs
    }
    case "rename": {                                                        // the "Name & details" pill on the playlist page
      const btn = byText("button", /name\s*&\s*details/i) || document.querySelector('[data-testid="entityTitle"] button');
      if (!btn) return { ok: false, error: "'Name & details' button not found" };
      click(btn);
      const input = await wait(() => document.querySelector('[data-testid="playlist-edit-details-name-input"], [role="dialog"] input[type="text"], [role="dialog"] input'), 4000);
      if (!input) return { ok: false, error: "Edit dialog did not open" };
      input.focus(); setValue(input, a); await sleep(250);
      const saveBtn = document.querySelector('[data-testid="playlist-edit-details-save-button"]') || byText('[role="dialog"] button', /^save$/i);
      if (!saveBtn) return { ok: false, error: "Save button not found" };
      click(saveBtn);
      return { ok: true };
    }
    case "openPanel": {                                                     // the "+ Add" pill opens the "Add to playlist" panel
      if (findPanel()) return { ok: true };
      const add = byText("button", /^\s*add\s*$/i);
      if (!add) return { ok: false, error: "'Add' button not found on the playlist page" };
      click(add);
      return (await wait(findPanel, 4000)) ? { ok: true } : { ok: false, error: "The Add to playlist panel did not open" };
    }
    case "panelOpen": return !!findPanel();
    case "search": {                                                        // a = query; types it and waits for the list to settle
      const panel = findPanel(), input = panel?.querySelector("input");
      if (!input) return { ok: false, error: "The Add to playlist panel is not open" };
      const before = rows(panel)[0]?.info.key || "";
      input.focus(); setValue(input, ""); await sleep(150); setValue(input, a);
      await sleep(1100);                                                    // let Spotify's search debounce fire
      const end = Date.now() + 7000;
      let last = "", stable = 0, cur = null;
      while (Date.now() < end) {
        if (/no results found/i.test(txt(panel))) return { state: "none" };
        cur = rows(panel)[0]?.info || null;
        const k = cur?.key || "";
        stable = k && k === last ? stable + 1 : 0; last = k;
        if (cur && stable >= 2 && (k !== before || Date.now() > end - 3500)) return { state: "rows", ...cur };
        await sleep(300);
      }
      return cur ? { state: "rows", ...cur } : { state: "none" };
    }
    case "results": {                                                       // a = {q, key}; re-reads the panel to confirm the search result
      const panel = findPanel(), input = panel?.querySelector("input");
      if (!input || input.value !== a.q) return null;
      if (!a.key) return /no results found/i.test(txt(panel)) ? { state: "none" } : null;
      const first = rows(panel)[0];
      return first && first.info.key === a.key ? { state: "rows", ...first.info } : null;
    }
    case "addFirst": {                                                      // a = key of the row we expect to add
      const panel = findPanel(), input = panel?.querySelector("input");
      if (!input) return { ok: false, error: "The Add to playlist panel closed" };
      const first = rows(panel)[0];
      if (!first) return { ok: false, error: "No (+) button found" };
      if (first.info.key !== a) return { ok: false, error: "The results changed before clicking" };
      if (/added|remove/i.test(first.b.getAttribute("aria-label") || "")) return { ok: true, already: true };   // never toggle it off
      click(first.b);
      return { ok: true };
    }
    case "outcome": {                                                       // duplicate prompt ("Already added")
      const skip = byText('[role="dialog"] button', /(don.?t add|skip)/i);
      if (skip) { click(skip); return "duplicate"; }
      return null;
    }
    case "rowState": {                                                      // fallback proof of adding when the song count can't be read
      const panel = findPanel(), input = panel?.querySelector("input");
      if (!input) return null;
      const mine = rows(panel).find((r) => r.info.key === a);
      if (!mine) return "added";
      return /added|remove/i.test(mine.b.getAttribute("aria-label") || "") ? "added" : null;
    }
    case "escape": {
      for (let k = 0; k < 2; k++) { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true })); await sleep(120); }
      return true;
    }
    case "banner": {
      let b = document.getElementById("mixvault-banner");
      if (!b) {
        b = document.createElement("div"); b.id = "mixvault-banner";
        b.style.cssText = "position:fixed;left:50%;bottom:92px;transform:translateX(-50%);z-index:2147483647;padding:10px 18px;border-radius:999px;background:rgba(28,28,30,.88);color:#fff;font:600 13px -apple-system,system-ui,sans-serif;backdrop-filter:blur(14px);box-shadow:0 8px 30px rgba(0,0,0,.35);pointer-events:none";
        document.documentElement.append(b);
      }
      b.textContent = a; return true;
    }
    case "unbanner": document.getElementById("mixvault-banner")?.remove(); return true;
  }
  return null;
}

/* ---- worker side: step runner ---- */
async function run(tabId, op, arg) {
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: pageOp, args: [op, arg ?? null] });
    return r?.result;
  } catch { return undefined; }   // page is navigating / not ready yet
}

async function until(fn, ms = 8000, every = 350) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ctl.cancelled) throw new Cancelled();
    try { const v = await fn(); if (v) return v; } catch (e) { if (e instanceof Cancelled) throw e; }
    await sleep(every);
  }
  return null;
}

// act -> verify (poll) -> retry. The next step never starts until verify() passes.
async function step(text, act, verify, { tries = 3, wait = 8000, recover } = {}) {
  note(text, "run");
  let err;
  for (let n = 1; n <= tries; n++) {
    if (ctl.cancelled) throw new Cancelled();
    try { await act(n); } catch (e) { if (e instanceof Cancelled) throw e; err = e; }
    const v = await until(verify, wait);
    if (v) { note(text, "ok"); return v; }
    if (recover) await recover();
  }
  note(text, "fail");
  throw new StepError(`${text} failed${err ? ` (${err.message})` : ": couldn't be confirmed on the page"}.`);
}

const queryFor = (t) => `${t.artist} ${t.title}`
  .replace(/\s+(ft\.?|feat\.?|featuring)\s+.*$/i, "").replace(/[()\[\]]/g, " ").replace(/\s+/g, " ").trim();

export async function runDirect(entryId) {
  if (ctl.running) return;
  ctl.running = true; ctl.cancelled = false;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  let tab, playlistId;
  try {
    const { library = [] } = await chrome.storage.local.get("library");
    const entry = library.find((e) => e.id === entryId);
    await startJob({ entryId, name: entry?.name || "Playlist", via: "direct", total: entry?.tracks.length || 0 });
    if (!entry) throw new StepError("That playlist is no longer in the library.");

    // 1. open Spotify and wait until the page is really loaded
    const existing = (await chrome.tabs.query({ url: HOME + "*" }))[0];
    tab = existing ? await chrome.tabs.update(existing.id, { url: HOME, active: true }) : await chrome.tabs.create({ url: HOME, active: true });
    chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    const loaded = async () => { const t = await chrome.tabs.get(tab.id); return t.status === "complete" && t.url?.startsWith(HOME); };
    await step("Opening Spotify", async () => { await sleep(700); },
      async () => (await loaded()) && (await run(tab.id, "status"))?.ready, { tries: 1, wait: 25000 });

    // 2. must be signed in
    note("Checking you're signed in", "run");
    if (!(await until(async () => (await run(tab.id, "status"))?.loggedIn, 12000)))
      throw new StepError("You're not signed in to Spotify. Sign in at open.spotify.com in this browser, then try again.");
    note("Checking you're signed in", "ok");

    // 3. create the playlist (verified by the URL becoming /playlist/<id>)
    playlistId = await step("Creating a new playlist", async () => {
      if ((await run(tab.id, "status"))?.playlistId) return;       // an earlier attempt already worked: never create a second one
      const r = await run(tab.id, "createPlaylist");
      if (!r?.ok) throw new Error(r?.error || "no response from the page");
    }, async () => (await run(tab.id, "status"))?.playlistId, { tries: 3, wait: 12000 });
    patch({ url: `${HOME}playlist/${playlistId}` });
    await until(async () => (await run(tab.id, "readPlaylist"))?.songs != null, 8000);   // header finished rendering

    // 4. name it via "Name & details" (verified by reading the title back)
    let target;
    try {
      target = await step(`Naming it “${entry.name}”`, async () => {
        if ((await run(tab.id, "readPlaylist"))?.title === entry.name) return;
        const r = await run(tab.id, "rename", entry.name);
        if (!r?.ok) throw new Error(r?.error || "no response from the page");
      }, async () => { const t = await run(tab.id, "readPlaylist"); return t?.title === entry.name ? t.title : null; }, { tries: 2, wait: 6000 });
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      await run(tab.id, "escape");
      target = (await run(tab.id, "readPlaylist"))?.title;
      if (!target) throw new StepError("Couldn't read the new playlist's name.");
      note(`Couldn't rename it, using “${target}”`, "warn");
    }

    // 5. open the "Add to playlist" panel once
    const ensurePanel = async () => {
      if (await run(tab.id, "panelOpen")) return;
      await step("Opening the Add to playlist panel", async () => {
        const r = await run(tab.id, "openPanel");
        if (!r?.ok) throw new Error(r?.error || "no response from the page");
      }, () => run(tab.id, "panelOpen"), { tries: 3, wait: 5000 });
    };
    await ensurePanel();

    // 6. each song: search in the panel -> confirm the top result -> press (+) -> confirm it landed
    let strikes = 0;
    for (let i = 0; i < entry.tracks.length; i++) {
      if (ctl.cancelled) throw new Cancelled();
      const t = entry.tracks[i], q = queryFor(t);
      await patch({ i: i + 1 });
      try {
        await ensurePanel();
        run(tab.id, "banner", `MixVault · adding ${i + 1} of ${entry.tracks.length} · please don't click`);

        let found = null;
        const res = await step(`Searching “${q}”`, async () => {
          found = await run(tab.id, "search", q);
          if (!found?.state) throw new Error("no response from the page");
        }, async () => (found ? run(tab.id, "results", { q, key: found.key || "" }) : null), { tries: 2, wait: 6000 });
        if (res.state === "none") { J().missed.push(`${t.artist} – ${t.title}`); note(`No Spotify result for “${q}”`, "warn"); save(); strikes = 0; continue; }

        const expect = J().added + 1;                                       // the new playlist should now hold this many songs
        let attempts = 0;
        let outcome = await step(`Adding “${res.title}”`, async (n) => {
          attempts = n;
          if (n > 1 && ((await run(tab.id, "readPlaylist"))?.songs ?? 0) >= expect) return;   // the first click had worked
          const r = await run(tab.id, "addFirst", res.key);
          if (!r?.ok) throw new Error(r?.error || "no response from the page");
        }, async () => {
          const o = await run(tab.id, "outcome");
          if (o) return o;
          const p = await run(tab.id, "readPlaylist");
          if (p?.songs != null && p.songs >= expect) return "added";
          if (p?.songs == null) return run(tab.id, "rowState", res.key);   // can't read the count: use the row's state instead
          return null;
        }, { tries: 2, wait: 8000 });
        if (outcome === "duplicate" && attempts > 1) outcome = "added";     // our own first click had worked
        outcome === "added" ? J().added++ : J().dup++;
        save();
        strikes = 0;
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        J().failed.push(`${t.artist} – ${t.title}`); save();
        if (++strikes >= 4) throw new StepError("Four songs in a row failed, so Spotify's page has probably changed. Stopping here.");
        await run(tab.id, "escape");
      }
    }

    // 7. final check: the playlist header should show as many songs as we added
    const url = `${HOME}playlist/${playlistId}`;
    const expected = J().added;
    if (!expected) throw new StepError("No songs were added. The empty playlist still exists on Spotify.");
    note("Checking the finished playlist", "run");
    const seen = await until(async () => { const r = await run(tab.id, "readPlaylist"); return r?.songs >= expected ? r : null; }, 8000);
    if (seen) note(`Verified: ${seen.songs} songs on Spotify`, "ok");
    else note(`Spotify shows ${(await run(tab.id, "readPlaylist"))?.songs ?? "?"} songs, expected ${expected}`, "warn");

    const lib = (await chrome.storage.local.get("library")).library || [];
    const e2 = lib.find((x) => x.id === entryId);
    if (e2) { e2.spotifyUrl = url; e2.spotifyVia = "direct"; await chrome.storage.local.set({ library: lib }); }
    await patch({ state: "done", url });
  } catch (e) {
    if (J()) await patch(e instanceof Cancelled ? { state: "cancelled" } : { state: "error", error: e.message || String(e) });
  } finally {
    if (tab) run(tab.id, "unbanner");
    clearInterval(keepAlive);
    ctl.running = false;
  }
}