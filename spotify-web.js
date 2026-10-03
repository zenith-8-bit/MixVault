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
  // Spotify is a React SPA, so prefer accessibility/test-id contracts and only then
  // fall back to DOM structure.  This is intentionally similar to the resilient
  // locator strategy used by current Playwright Spotify projects.
  const click = (e) => {
    if (!e) return false;
    e.scrollIntoView?.({ block: "center", inline: "nearest" });
    try { e.focus?.({ preventScroll: true }); } catch {}
    e.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    e.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    e.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    e.click();
    return true;
  };
  const setValue = (el, v) => {
    if (!el) return;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, v); else el.value = v;
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  };
  const ITEMS = '[role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="menu"] button, [role="menu"] li';

  const label = (e) => [
    e?.getAttribute?.("aria-label"),
    e?.getAttribute?.("title"),
    e?.getAttribute?.("data-testid"),
    txt(e)
  ].filter(Boolean).join(" ").trim();

  const firstVisible = (selectors, root = document) => {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (vis(el)) return el;
    }
    return null;
  };

  const byLabel = (re, root = document) => $$("button, [role=button], input, [role=option]", root)
    .find((e) => vis(e) && re.test(label(e)));

  // Locate Spotify's Add-to-playlist surface without relying on its width/height.
  // Spotify has changed the panel DOM several times; dialog/heading/placeholder
  // and then ancestor heuristics give us multiple independent ways to find it.
  const findPanel = () => {
    const direct = firstVisible([
      '[data-testid="add-to-playlist-dialog"]',
      '[data-testid="add-to-playlist-panel"]',
      '[role="dialog"]'
    ]);
    if (direct && (direct.querySelector("input") || /add to playlist/i.test(txt(direct)))) return direct;

    const input = firstVisible([
      'input[placeholder*="Search" i]',
      'input[aria-label*="Search" i]',
      'input[type="search"]'
    ]);
    if (input) {
      for (let p = input.parentElement; p && p !== document.body; p = p.parentElement) {
        if (/add to playlist/i.test(txt(p)) || $$("button", p).some((b) => /add to playlist|^add$/i.test(label(b)))) {
          return p;
        }
      }
    }

    const head = $$("h1,h2,h3,h4,[role=heading],span,div,p")
      .find((e) => !e.children.length && vis(e) && /^add to playlist$/i.test(txt(e)));
    for (let p = head; p && p !== document.body; p = p.parentElement) {
      if (p.querySelector("input")) return p;
    }
    return null;
  };

  // Extract result rows by finding explicit Add buttons first.  If Spotify doesn't
  // expose a useful label, fall back to the smallest ancestor containing one action
  // button and meaningful track text.
  const rows = (panel) => {
    if (!panel) return [];
    const input = panel.querySelector('input[placeholder*="Search" i], input[aria-label*="Search" i], input[type="search"], input');
    const buttons = $$("button, [role=button]", panel).filter((b) => {
      if (!vis(b) || b === input) return false;
      const l = label(b);
      return /add to playlist|add|remove from playlist|remove/i.test(l) &&
        !/close|clear search|search|previous|next|more options/i.test(l);
    });

    const candidates = buttons.length ? buttons : $$("button", panel).filter((b) => {
      if (!vis(b)) return false;
      const l = label(b);
      return b.querySelector("svg") && !/close|clear|search|more options/i.test(l);
    });

    return candidates.map((b) => {
      let el = b;
      for (let k = 0; k < 8; k++) {
        const par = el.parentElement;
        if (!par || par === panel) break;
        const text = txt(par);
        const actionCount = $$("button,[role=button]", par).filter(vis).length;
        if (text.length >= 3 && text.length <= 220 && actionCount <= 2) el = par;
        else break;
      }
      const lines = (el.innerText || txt(el)).split("\n").map((s) => s.trim()).filter((s) => s.length > 1);
      return {
        b,
        info: {
          title: lines[0] || "",
          artist: lines.slice(1).join(", "),
          key: lines.join("|")
        }
      };
    }).filter((r) => r.info.title && !/suggested (songs|episodes)/i.test(r.info.key));
  };

  switch (op) {
    case "status": {
      const loginBtn = !!document.querySelector('[data-testid="login-button"]') || !!byText("button, a", /^log in$/i);
      const appUi = !!firstVisible([
        '[data-testid="user-widget-link"]',
        '[data-testid="create-playlist-button"]',
        'nav[aria-label="Main"]',
        '[aria-label="Your Library"]',
        'button[aria-label*="Create playlist" i]'
      ]) || !!byText("button, [role=button]", /^create$/i);
      const m = location.pathname.match(/^\/playlist\/([A-Za-z0-9]+)/);
      return {
        ready: document.readyState === "complete" && !!document.querySelector("#main, main, [data-testid='main']"),
        loggedIn: appUi && !loginBtn, path: location.pathname, playlistId: m ? m[1] : null,
      };
    }
    case "createPlaylist": {
      // Spotify currently exposes this in a few forms:
      //   * button[data-testid="create-playlist-button"] (older/stable web UI)
      //   * a "+ Create" control beside Your Library
      //   * a button whose accessible name is simply "Create"
      //   * a Create menu containing Playlist / New playlist
      // Do not depend on one exact React class or SVG structure.
      const libraryRoot = (() => {
        const candidates = $$('nav, aside, [aria-label*="Your Library" i], [data-testid*="library" i]')
          .filter(vis);
        return candidates.find((e) => /your library/i.test(label(e) + " " + txt(e))) || candidates[0] || document;
      })();

      const clickable = (root = document) => $$('button, [role="button"], a, [tabindex="0"]', root)
        .filter(vis);

      const createScore = (e) => {
        const l = label(e);
        const t = txt(e);
        let score = 0;
        if (/create-playlist/i.test(e.getAttribute?.('data-testid') || '')) score += 100;
        if (/create\s+playlist/i.test(l)) score += 90;
        if (/create playlist or folder/i.test(l)) score += 85;
        if (/^create$/i.test((e.getAttribute?.('aria-label') || '').trim())) score += 80;
        if (/^\+?\s*create\s*$/i.test(t)) score += 75;
        if (/^\+?\s*create\s+playlist\s*$/i.test(t)) score += 75;
        if (/your library/i.test(e.parentElement?.innerText || '')) score += 30;
        // Prefer controls near the left/sidebar portion of the viewport.
        const r = e.getBoundingClientRect?.();
        if (r && r.left < Math.max(520, innerWidth * 0.35)) score += 10;
        return score;
      };

      let btn = firstVisible([
        '[data-testid="create-playlist-button"]',
        '[data-testid*="create-playlist" i]',
        'button[aria-label*="Create playlist" i]',
        '[role="button"][aria-label*="Create playlist" i]',
        'button[aria-label="Create"]',
        '[role="button"][aria-label="Create"]'
      ]) || null;

      if (!btn) {
        const pool = [...new Set([...clickable(libraryRoot), ...clickable(document)])];
        btn = pool.sort((a, b) => createScore(b) - createScore(a))[0] || null;
        if (createScore(btn) < 50) btn = null;
      }

      // Some layouts render the library header only after clicking Your Library.
      if (!btn) {
        const lib = byLabel(/^your library$/i) || byText('a,button,[role="button"]', /^your library$/i);
        if (lib) {
          click(lib);
          await sleep(500);
          btn = firstVisible([
            '[data-testid="create-playlist-button"]',
            '[data-testid*="create-playlist" i]',
            'button[aria-label*="Create playlist" i]',
            '[role="button"][aria-label*="Create playlist" i]',
            'button[aria-label="Create"]',
            '[role="button"][aria-label="Create"]'
          ]);
        }
      }

      if (!btn) return { ok: false, error: "Create button not found in the Your Library area" };
      click(btn);

      // Newer builds may open the playlist-name dialog immediately.
      const directInput = await wait(() => firstVisible([
        '[role="dialog"] input[placeholder*="playlist" i]',
        '[role="dialog"] input[aria-label*="playlist" i]',
        '[role="dialog"] input[type="text"]'
      ]), 1800);
      if (directInput) {
        if (a) { directInput.focus(); setValue(directInput, a); await sleep(200); }
        const createDialog = firstVisible([
          '[role="dialog"] button[type="submit"]',
          '[role="dialog"] button[aria-label="Create"]',
          '[role="dialog"] button'
        ], document.querySelector('[role="dialog"]') || document);
        if (createDialog && /create/i.test(label(createDialog) + ' ' + txt(createDialog))) {
          click(createDialog);
          return { ok: true };
        }
      }

      const item = await wait(() =>
        byText(ITEMS, /^(?:new\s+)?playlist(?:\s+or\s+folder)?$/i) ||
        byText(ITEMS, /^create\s+playlist$/i) ||
        byText('[role="menu"] *, [role="listbox"] *', /^(?:new\s+)?playlist$/i), 5000);
      if (item) { click(item); return { ok: true }; }
      if (/^\/playlist\//.test(location.pathname)) return { ok: true };
      return { ok: false, error: "Playlist option not found after opening Create" };
    }
    case "readPlaylist": {
      const root = document.querySelector("main, [data-testid='main'], #main") || document.body;
      const title = txt(firstVisible([
        '[data-testid="entityTitle"] h1',
        '[data-testid="entityTitle"]',
        'main h1',
        'h1'
      ], root));
      const head = txt(root).slice(0, 4000);
      const loaded = /^\/playlist\//.test(location.pathname) || /\\b(public|private|playlist)\\b/i.test(head);
      const m = head.match(/(\\d[\\d,]*)\\s+songs?\\b/i);
      const rowCount = $$('[data-testid="tracklist-row"], [role="row"]', root).filter(vis).length;
      return {
        title,
        songs: !loaded ? null : m ? +m[1].replace(/,/g, "") : (rowCount ? rowCount : null)
      };
    }
    case "rename": {                                                        // the "Name & details" pill on the playlist page
      const btn = firstVisible([
        '[data-testid="playlist-edit-details-button"]',
        '[data-testid="entityTitle"] button'
      ]) || byLabel(/name\s*&\s*details|edit playlist details/i) || byText("button, [role=button]", /name\s*&\s*details/i);
      if (!btn) return { ok: false, error: "'Name & details' button not found" };
      click(btn);
      const input = await wait(() => firstVisible([
        '[data-testid="playlist-edit-details-name-input"]',
        '[role="dialog"] input[type="text"]',
        '[role="dialog"] input'
      ]), 5000);
      if (!input) return { ok: false, error: "Edit dialog did not open" };
      input.focus(); setValue(input, a); await sleep(250);
      const saveBtn = firstVisible([
        '[data-testid="playlist-edit-details-save-button"]',
        '[role="dialog"] button[type="submit"]'
      ]) || byLabel(/^save$/i, document.querySelector('[role="dialog"]') || document) || byText('[role="dialog"] button', /^save$/i);
      if (!saveBtn) return { ok: false, error: "Save button not found" };
      click(saveBtn);
      return { ok: true };
    }
    case "openPanel": {                                                     // the "+ Add" pill opens the "Add to playlist" panel
      if (findPanel()) return { ok: true };
      const add = firstVisible([
        'button[aria-label="Add"]',
        'button[aria-label*="Add to playlist" i]',
        '[data-testid="add-to-playlist-button"]'
      ]) || byLabel(/^add( to playlist)?$/i) || byText("button, [role=button]", /^\s*add( to playlist)?\s*$/i);
      if (!add) return { ok: false, error: "'Add' button not found on the playlist page" };
      click(add);
      return (await wait(findPanel, 4000)) ? { ok: true } : { ok: false, error: "The Add to playlist panel did not open" };
    }
    case "panelOpen": return !!findPanel();
    case "search": {                                                        // a = query; types it and waits for the list to settle
      const panel = findPanel(), input = panel && firstVisible([
        'input[placeholder*="Search" i]',
        'input[aria-label*="Search" i]',
        'input[type="search"]',
        'input'
      ], panel);
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
      const panel = findPanel(), input = panel && firstVisible([
        'input[placeholder*="Search" i]',
        'input[aria-label*="Search" i]',
        'input[type="search"]',
        'input'
      ], panel);
      if (!input || input.value !== a.q) return null;
      if (!a.key) return /no results found/i.test(txt(panel)) ? { state: "none" } : null;
      const first = rows(panel)[0];
      return first && first.info.key === a.key ? { state: "rows", ...first.info } : null;
    }
    case "addFirst": {                                                      // a = {key,title,artist}
      const panel = findPanel(), input = panel && firstVisible([
        'input[placeholder*="Search" i]',
        'input[aria-label*="Search" i]',
        'input[type="search"]',
        'input'
      ], panel);
      if (!input) return { ok: false, error: "The Add to playlist panel closed" };

      // Re-read the live DOM immediately before clicking. Spotify re-renders
      // result rows after every add, so never retain a button/row from a prior call.
      const list = rows(panel);
      let first = a?.key ? list.find((r) => r.info.key === a.key) : list[0];
      if (!first && a?.title) {
        const norm = (v) => String(v || "").toLowerCase().replace(/\s+/g, " ").trim();
        const title = norm(a.title);
        first = list.find((r) => norm(r.info.title) === title);
      }
      if (!first) return { ok: false, error: "The requested Spotify result is no longer in the live result list" };

      const before = label(first.b);
      if (/added|remove from playlist|remove$/i.test(before)) return { ok: true, already: true };

      click(first.b);

      // Wait for React/Spotify to commit the click. This is important because
      // the result row is usually replaced rather than mutated in place.
      const end = Date.now() + 3500;
      while (Date.now() < end) {
        await sleep(180);
        const fresh = rows(findPanel() || panel);
        const same = a?.key ? fresh.find((r) => r.info.key === a.key) : fresh[0];
        if (!same) return { ok: true, changed: true };
        const state = label(same.b);
        if (/added|remove from playlist|remove$/i.test(state)) return { ok: true, changed: true };
      }
      // A successful click can cause the result to disappear completely.
      // Do not click again merely because Spotify has not painted the state yet.
      return { ok: true, pending: true };
    }
    case "outcome": {                                                       // duplicate prompt ("Already added")
      const skip = byLabel(/don.?t add|skip/i, document.querySelector('[role="dialog"]') || document) ||
        byText('[role="dialog"] button, [role="dialog"] [role=button]', /(don.?t add|skip)/i);
      if (skip) { click(skip); return "duplicate"; }
      return null;
    }
    case "rowState": {                                                      // fallback proof of adding when the song count can't be read
      const panel = findPanel(), input = panel && firstVisible([
        'input[placeholder*="Search" i]',
        'input[aria-label*="Search" i]',
        'input[type="search"]',
        'input'
      ], panel);
      if (!input) return null;
      const mine = rows(panel).find((r) => r.info.key === a);
      if (!mine) return "added";
      return /added|remove/i.test(label(mine.b)) ? "added" : null;
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

    // 1. open Spotify and wait until the page is really loaded.
    // If this captured playlist was already sent to Spotify, reuse its saved URL
    // instead of creating a second playlist on every run.
    const targetUrl = entry.spotifyUrl || HOME;
    const existing = (await chrome.tabs.query({ url: HOME + "*" }))[0];
    tab = existing ? await chrome.tabs.update(existing.id, { url: targetUrl, active: true }) : await chrome.tabs.create({ url: targetUrl, active: true });
    chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    const loaded = async () => {
      const t = await chrome.tabs.get(tab.id);
      return t.status === "complete" && t.url?.startsWith(HOME);
    };
    await step("Opening Spotify", async () => { await sleep(700); },
      async () => (await loaded()) && (await run(tab.id, "status"))?.ready, { tries: 1, wait: 25000 });

    // 2. must be signed in
    note("Checking you're signed in", "run");
    if (!(await until(async () => (await run(tab.id, "status"))?.loggedIn, 12000)))
      throw new StepError("You're not signed in to Spotify. Sign in at open.spotify.com in this browser, then try again.");
    note("Checking you're signed in", "ok");

    // 3. create the playlist only when this capture has no saved Spotify playlist.
    // If a previous run already created one, keep using that playlist.
    playlistId = await step(entry.spotifyUrl ? "Opening existing playlist" : "Creating a new playlist", async () => {
      const current = (await run(tab.id, "status"))?.playlistId;
      if (current) return;
      if (entry.spotifyUrl) throw new Error("Saved Spotify playlist did not open.");
      const r = await run(tab.id, "createPlaylist", entry.name);
      if (!r?.ok) throw new Error(r?.error || "no response from the page");
    }, async () => (await run(tab.id, "status"))?.playlistId, { tries: entry.spotifyUrl ? 2 : 3, wait: 12000 });
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
          const current = await run(tab.id, "rowState", res.key);
          if (current === "added") return;                                      // never click an already-added row again
          const r = await run(tab.id, "addFirst", { key: res.key, title: res.title, artist: res.artist });
          if (!r?.ok) throw new Error(r?.error || "no response from the page");
        }, async () => {
          const o = await run(tab.id, "outcome");
          if (o) return o;
          // The strongest signal while the panel is open is the row changing
          // from Add to Remove/Added. The playlist header can lag behind the panel.
          const row = await run(tab.id, "rowState", res.key);
          if (row === "added") return "added";
          const p = await run(tab.id, "readPlaylist");
          if (p?.songs != null && p.songs >= expect) return "added";
          return null;
        }, { tries: 2, wait: 9000 });
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