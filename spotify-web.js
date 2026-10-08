// MixVault - Spotify Direct DOM implementation
// Drop-in replacement for spotify-web.js.
// Drives the signed-in Spotify Web Player UI only; no Spotify API is used.
//
// Reliability changes:
//   1. Never keep a stale Add-to-playlist panel across React renders.
//   2. Never treat a missing result row as proof that a song was added.
//   3. Search waits for the query to be reflected in the LIVE input and for
//      the same result to survive multiple live-DOM samples.
//   4. Add verification accepts only explicit Added/Remove state,
//      duplicate confirmation, or a playlist song-count increase.
//   5. A click is never reported as successful merely because it was clicked.
//   6. A failed verification does NOT retry the song.
//   7. A failed song is recorded and the worker continues with the next song.
//   8. There is NO four-strikes stop condition.

import { ctl, J, startJob, patch, note, save } from "./job.js";

const HOME = "https://open.spotify.com/";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class StepError extends Error {}
class Cancelled extends Error {}

/* -------------------------------------------------------------------------- */
/* Code below pageOp runs INSIDE the Spotify page via chrome.scripting.       */
/* -------------------------------------------------------------------------- */
async function pageOp(op, a) {
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];

  const txt = (e) => ((e && (e.innerText || e.textContent)) || "")
    .replace(/\s+/g, " ")
    .trim();

  const vis = (e) =>
    !!e &&
    (e.offsetParent !== null || e.getClientRects().length > 0);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const wait = async (fn, ms = 4000, every = 120) => {
    const end = Date.now() + ms;

    while (Date.now() < end) {
      const value = fn();

      if (value) return value;

      await sleep(every);
    }

    return null;
  };

  const byText = (sel, re, root = document) =>
    $$(sel, root).find((e) => vis(e) && re.test(txt(e)));

  const click = (e) => {
    if (!e || !document.contains(e)) return false;

    try {
      e.scrollIntoView?.({
        block: "center",
        inline: "nearest"
      });
    } catch {}

    try {
      e.focus?.({
        preventScroll: true
      });
    } catch {}

    try {
      e.dispatchEvent(
        new MouseEvent("mouseover", {
          bubbles: true
        })
      );

      e.dispatchEvent(
        new MouseEvent("mousedown", {
          bubbles: true,
          cancelable: true,
          view: window
        })
      );

      e.dispatchEvent(
        new MouseEvent("mouseup", {
          bubbles: true,
          cancelable: true,
          view: window
        })
      );
    } catch {}

    try {
      e.click();
    } catch {
      return false;
    }

    return true;
  };

  // Keyboard fallback for Spotify's Add button.
  const keyboardActivate = (e) => {
    if (!e || !document.contains(e) || !vis(e)) return false;

    try {
      e.scrollIntoView?.({
        block: "center",
        inline: "nearest"
      });
    } catch {}

    try {
      e.focus?.({
        preventScroll: true
      });
    } catch {}

    if (document.activeElement !== e) return false;

    const fire = (type, key, code, keyCode) => {
      try {
        e.dispatchEvent(
          new KeyboardEvent(type, {
            key,
            code,
            keyCode,
            which: keyCode,
            bubbles: true,
            cancelable: true
          })
        );
      } catch {}
    };

    fire("keydown", "Enter", "Enter", 13);
    fire("keyup", "Enter", "Enter", 13);

    return true;
  };

  const findAddButtonFallback = (expected = {}) => {
    const panel = findPanel();

    if (!panel) return null;

    const wantedTitle = normalize(expected.title);
    const wantedArtist = normalize(expected.artist);

    const adds = $$(
      'button, [role="button"]',
      panel
    ).filter((b) => {
      if (!vis(b)) return false;

      const l = normalize(label(b));

      return (
        /^add$/.test(l) ||
        /^add to playlist$/.test(l)
      );
    });

    if (!adds.length) return null;

    if (!wantedTitle) return adds[0];

    for (const button of adds) {
      let node = button;

      for (
        let i = 0;
        i < 8 && node && node !== panel;
        i++, node = node.parentElement
      ) {
        const t = normalize(txt(node));

        if (
          t.includes(wantedTitle) &&
          (!wantedArtist || t.includes(wantedArtist))
        ) {
          return button;
        }
      }
    }

    return adds[0];
  };

  // React-compatible native value setter.
  const setValue = (el, value) => {
    if (!el) return;

    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;

    const setter =
      Object.getOwnPropertyDescriptor(proto, "value")?.set;

    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }

    el.dispatchEvent(
      new Event("input", {
        bubbles: true,
        composed: true
      })
    );

    el.dispatchEvent(
      new Event("change", {
        bubbles: true,
        composed: true
      })
    );
  };

  const ITEMS =
    '[role="menuitem"], [role="menuitemcheckbox"], [role="option"], [role="menu"] button, [role="menu"] li';

  const label = (e) =>
    [
      e?.getAttribute?.("aria-label"),
      e?.getAttribute?.("title"),
      e?.getAttribute?.("data-testid"),
      txt(e)
    ]
      .filter(Boolean)
      .join(" ")
      .trim();

  const firstVisible = (selectors, root = document) => {
    for (const selector of selectors) {
      const el = root.querySelector(selector);

      if (vis(el)) return el;
    }

    return null;
  };

  const byLabel = (re, root = document) =>
    $$(
      "button, [role=button], input, [role=option]",
      root
    ).find((e) => vis(e) && re.test(label(e)));

  const searchInput = (root = document) =>
    firstVisible(
      [
        'input[placeholder*="Search" i]',
        'input[aria-label*="Search" i]',
        'input[type="search"]',
        "input"
      ],
      root
    );

  /* --------------------------- panel discovery --------------------------- */

  const findPanel = () => {
    const direct = firstVisible([
      '[data-testid="add-to-playlist-dialog"]',
      '[data-testid="add-to-playlist-panel"]',
      '[role="dialog"]'
    ]);

    if (
      direct &&
      (searchInput(direct) ||
        /add to playlist/i.test(txt(direct)))
    ) {
      return direct;
    }

    const input = searchInput(document);

    if (input) {
      for (
        let p = input.parentElement;
        p && p !== document.body;
        p = p.parentElement
      ) {
        if (
          /add to playlist/i.test(txt(p)) ||
          $$("button", p).some((b) =>
            /add to playlist|^add$/i.test(label(b))
          )
        ) {
          return p;
        }
      }
    }

    const head = $$(
      "h1,h2,h3,h4,[role=heading],span,div,p"
    ).find(
      (e) =>
        !e.children.length &&
        vis(e) &&
        /^add to playlist$/i.test(txt(e))
    );

    for (
      let p = head;
      p && p !== document.body;
      p = p.parentElement
    ) {
      if (searchInput(p)) return p;
    }

    return null;
  };

  /* --------------------------- result extraction ------------------------- */

  const rows = (panel) => {
    if (!panel || !document.contains(panel)) return [];

    const input = searchInput(panel);

    const buttons = $$(
      "button, [role=button]",
      panel
    ).filter((button) => {
      if (!vis(button) || button === input) return false;

      const l = label(button);

      return (
        /add to playlist|add|remove from playlist|remove/i.test(l) &&
        !/close|clear search|search|previous|next|more options/i.test(l)
      );
    });

    const candidates = buttons.length
      ? buttons
      : $$("button", panel).filter((button) => {
          if (!vis(button)) return false;

          const l = label(button);

          return (
            button.querySelector("svg") &&
            !/close|clear|search|more options/i.test(l)
          );
        });

    return candidates
      .map((button) => {
        let el = button;

        for (let k = 0; k < 8; k++) {
          const parent = el.parentElement;

          if (!parent || parent === panel) break;

          const text = txt(parent);

          const actionCount = $$(
            "button,[role=button]",
            parent
          ).filter(vis).length;

          if (
            text.length >= 3 &&
            text.length <= 220 &&
            actionCount <= 2
          ) {
            el = parent;
          } else {
            break;
          }
        }

        const lines = (el.innerText || txt(el))
          .split("\n")
          .map((s) => s.trim())
          .filter((s) => s.length > 1);

        return {
          b: button,

          info: {
            title: lines[0] || "",
            artist: lines.slice(1).join(", "),
            key: lines.join("|")
          }
        };
      })
      .filter(
        (r) =>
          r.info.title &&
          !/suggested (songs|episodes)/i.test(r.info.key)
      );
  };

  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\s+/g, " ")
      .trim();

  const isAddedLabel = (value) =>
    /\b(?:added|remove from playlist|remove)\b/i.test(
      String(value || "")
    );

  const findResult = (expected = {}) => {
    const panel = findPanel();

    if (!panel) {
      return {
        panel: null,
        row: null
      };
    }

    const list = rows(panel);

    if (!list.length) {
      return {
        panel,
        row: null
      };
    }

    if (expected.key) {
      const exact = list.find(
        (r) => r.info.key === expected.key
      );

      if (exact) {
        return {
          panel,
          row: exact
        };
      }
    }

    const title = normalize(expected.title);
    const artist = normalize(expected.artist);

    if (title && artist) {
      const exact = list.find((r) => {
        const rt = normalize(r.info.title);
        const ra = normalize(r.info.artist);

        return (
          rt === title &&
          (
            ra === artist ||
            ra.includes(artist) ||
            artist.includes(ra)
          )
        );
      });

      if (exact) {
        return {
          panel,
          row: exact
        };
      }
    }

    if (title) {
      const exactTitle = list.find(
        (r) => normalize(r.info.title) === title
      );

      if (exactTitle) {
        return {
          panel,
          row: exactTitle
        };
      }
    }

    return {
      panel,
      row: null
    };
  };

  switch (op) {
    case "status": {
      const loginBtn =
        !!document.querySelector(
          '[data-testid="login-button"]'
        ) ||
        !!byText(
          "button, a",
          /^log in$/i
        );

      const appUi =
        !!firstVisible([
          '[data-testid="user-widget-link"]',
          '[data-testid="create-playlist-button"]',
          'nav[aria-label="Main"]',
          '[aria-label="Your Library"]',
          'button[aria-label*="Create playlist" i]'
        ]) ||
        !!byText(
          "button, [role=button]",
          /^create$/i
        );

      const m = location.pathname.match(
        /^\/playlist\/([A-Za-z0-9]+)/
      );

      return {
        ready:
          document.readyState === "complete" &&
          !!document.querySelector(
            "#main, main, [data-testid='main']"
          ),

        loggedIn: appUi && !loginBtn,

        path: location.pathname,

        playlistId: m ? m[1] : null
      };
    }

    case "createPlaylist": {
      const libraryRoot = (() => {
        const candidates = $$(
          'nav, aside, [aria-label*="Your Library" i], [data-testid*="library" i]'
        ).filter(vis);

        return (
          candidates.find((e) =>
            /your library/i.test(
              label(e) + " " + txt(e)
            )
          ) ||
          candidates[0] ||
          document
        );
      })();

      const clickable = (root = document) =>
        $$(
          'button, [role="button"], a, [tabindex="0"]',
          root
        ).filter(vis);

      const createScore = (e) => {
        if (!e) return 0;

        const l = label(e);
        const t = txt(e);

        let score = 0;

        if (
          /create-playlist/i.test(
            e.getAttribute?.("data-testid") || ""
          )
        ) {
          score += 100;
        }

        if (/create\s+playlist/i.test(l)) score += 90;

        if (/create playlist or folder/i.test(l)) score += 85;

        if (
          /^create$/i.test(
            (e.getAttribute?.("aria-label") || "").trim()
          )
        ) {
          score += 80;
        }

        if (/^\+?\s*create\s*$/i.test(t)) score += 75;

        if (/^\+?\s*create\s+playlist\s*$/i.test(t)) {
          score += 75;
        }

        if (
          /your library/i.test(
            e.parentElement?.innerText || ""
          )
        ) {
          score += 30;
        }

        const r = e.getBoundingClientRect?.();

        if (
          r &&
          r.left < Math.max(
            520,
            innerWidth * 0.35
          )
        ) {
          score += 10;
        }

        return score;
      };

      let btn = firstVisible([
        '[data-testid="create-playlist-button"]',
        '[data-testid*="create-playlist" i]',
        'button[aria-label*="Create playlist" i]',
        '[role="button"][aria-label*="Create playlist" i]',
        'button[aria-label="Create"]',
        '[role="button"][aria-label="Create"]'
      ]);

      if (!btn) {
        const pool = [
          ...new Set([
            ...clickable(libraryRoot),
            ...clickable(document)
          ])
        ];

        btn =
          pool.sort(
            (x, y) =>
              createScore(y) -
              createScore(x)
          )[0] || null;

        if (createScore(btn) < 50) {
          btn = null;
        }
      }

      if (!btn) {
        const lib =
          byLabel(/^your library$/i) ||
          byText(
            'a,button,[role="button"]',
            /^your library$/i
          );

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

      if (!btn) {
        return {
          ok: false,
          error:
            "Create button not found in the Your Library area"
        };
      }

      click(btn);

      const directInput = await wait(
        () =>
          firstVisible([
            '[role="dialog"] input[placeholder*="playlist" i]',
            '[role="dialog"] input[aria-label*="playlist" i]',
            '[role="dialog"] input[type="text"]'
          ]),
        1800
      );

      if (directInput) {
        if (a) {
          directInput.focus();
          setValue(directInput, a);

          await sleep(200);
        }

        const dialog =
          document.querySelector(
            '[role="dialog"]'
          ) || document;

        const createDialog = firstVisible(
          [
            '[role="dialog"] button[type="submit"]',
            '[role="dialog"] button[aria-label="Create"]',
            '[role="dialog"] button'
          ],
          dialog
        );

        if (
          createDialog &&
          /create/i.test(
            label(createDialog) +
            " " +
            txt(createDialog)
          )
        ) {
          click(createDialog);

          return {
            ok: true
          };
        }
      }

      const item = await wait(
        () =>
          byText(
            ITEMS,
            /^(?:new\s+)?playlist(?:\s+or\s+folder)?$/i
          ) ||
          byText(
            ITEMS,
            /^create\s+playlist$/i
          ) ||
          byText(
            '[role="menu"] *, [role="listbox"] *',
            /^(?:new\s+)?playlist$/i
          ),
        5000
      );

      if (item) {
        click(item);

        return {
          ok: true
        };
      }

      if (/^\/playlist\//.test(location.pathname)) {
        return {
          ok: true
        };
      }

      return {
        ok: false,
        error:
          "Playlist option not found after opening Create"
      };
    }

    case "readPlaylist": {
      const root =
        document.querySelector(
          "main, [data-testid='main'], #main"
        ) || document.body;

      const title = txt(
        firstVisible(
          [
            '[data-testid="entityTitle"] h1',
            '[data-testid="entityTitle"]',
            "main h1",
            "h1"
          ],
          root
        )
      );

      const head = txt(root).slice(0, 4000);

      const loaded =
        /^\/playlist\//.test(location.pathname) ||
        /\b(public|private|playlist)\b/i.test(head);

      const m = head.match(
        /(\d[\d,]*)\s+songs?\b/i
      );

      const rowCount = $$(
        '[data-testid="tracklist-row"], [role="row"]',
        root
      ).filter(vis).length;

      return {
        title,

        songs: !loaded
          ? null
          : m
            ? +m[1].replace(/,/g, "")
            : rowCount || null
      };
    }

    case "rename": {
      const btn =
        firstVisible([
          '[data-testid="playlist-edit-details-button"]',
          '[data-testid="entityTitle"] button'
        ]) ||
        byLabel(
          /name\s*&\s*details|edit playlist details/i
        ) ||
        byText(
          "button, [role=button]",
          /name\s*&\s*details/i
        );

      if (!btn) {
        return {
          ok: false,
          error:
            "'Name & details' button not found"
        };
      }

      click(btn);

      const input = await wait(
        () =>
          firstVisible([
            '[data-testid="playlist-edit-details-name-input"]',
            '[role="dialog"] input[type="text"]',
            '[role="dialog"] input'
          ]),
        5000
      );

      if (!input) {
        return {
          ok: false,
          error:
            "Edit dialog did not open"
        };
      }

      input.focus();

      setValue(input, a);

      await sleep(250);

      const dialog =
        document.querySelector(
          '[role="dialog"]'
        ) || document;

      const saveBtn =
        firstVisible(
          [
            '[data-testid="playlist-edit-details-save-button"]',
            '[role="dialog"] button[type="submit"]'
          ],
          dialog
        ) ||
        byLabel(/^save$/i, dialog) ||
        byText(
          '[role="dialog"] button',
          /^save$/i
        );

      if (!saveBtn) {
        return {
          ok: false,
          error:
            "Save button not found"
        };
      }

      click(saveBtn);

      return {
        ok: true
      };
    }

    case "openPanel": {
      if (findPanel()) {
        return {
          ok: true
        };
      }

      const add =
        firstVisible([
          'button[aria-label="Add"]',
          'button[aria-label*="Add to playlist" i]',
          '[data-testid="add-to-playlist-button"]'
        ]) ||
        byLabel(
          /^add( to playlist)?$/i
        ) ||
        byText(
          "button, [role=button]",
          /^\s*add( to playlist)?\s*$/i
        );

      if (!add) {
        return {
          ok: false,
          error:
            "'Add' button not found on the playlist page"
        };
      }

      click(add);

      return (await wait(
        findPanel,
        5000,
        150
      ))
        ? {
            ok: true
          }
        : {
            ok: false,
            error:
              "The Add to playlist panel did not open"
          };
    }

    case "panelOpen":
      return !!findPanel();

    /* ----------------------------- DOM SEARCH ----------------------------- */

    case "search": {
      const query = String(a || "").trim();

      if (!query) {
        return {
          state: "none",
          error:
            "Empty search query"
        };
      }

      let panel = findPanel();

      let input =
        panel &&
        searchInput(panel);

      if (!input) {
        return {
          ok: false,
          error:
            "The Add to playlist panel is not open"
        };
      }

      input.focus();

      setValue(input, "");

      await sleep(450);

      panel = findPanel();

      input =
        panel &&
        searchInput(panel);

      if (!input) {
        return {
          ok: false,
          error:
            "Search input disappeared after clearing"
        };
      }

      input.focus();

      setValue(input, query);

      const end = Date.now() + 14000;

      let lastKey = "";
      let stable = 0;
      let lastInfo = null;
      let sawExactQuery = false;

      while (Date.now() < end) {
        panel = findPanel();

        if (!panel) {
          await sleep(250);
          continue;
        }

        input = searchInput(panel);

        if (!input) {
          await sleep(250);
          continue;
        }

        const currentQuery =
          String(input.value || "").trim();

        if (currentQuery !== query) {
          input.focus();

          setValue(input, query);

          stable = 0;
          lastKey = "";

          await sleep(400);

          continue;
        }

        sawExactQuery = true;

        const currentRows = rows(panel);

        const panelText = txt(panel);

        if (!currentRows.length) {
          if (/no results found/i.test(panelText)) {
            return {
              state: "none"
            };
          }

          await sleep(300);
          continue;
        }

        const normalizedQuery =
          normalize(query);

        const queryTokens =
          normalizedQuery
            .split(/\s+/)
            .filter(Boolean);

        const scored = currentRows
          .map((r) => {
            const hay = normalize(
              `${r.info.title} ${r.info.artist}`
            );

            const score =
              queryTokens.reduce(
                (n, token) =>
                  n + (hay.includes(token) ? 1 : 0),
                0
              );

            return {
              r,
              score
            };
          })
          .sort(
            (x, y) =>
              y.score - x.score
          );

        const best = scored[0];

        if (
          !best ||
          best.score <
            Math.max(
              1,
              Math.min(
                2,
                queryTokens.length
              )
            )
        ) {
          stable = 0;
          lastKey = "";

          await sleep(300);
          continue;
        }

        const current = best.r.info;

        if (
          current.key &&
          current.key === lastKey
        ) {
          stable++;
        } else {
          lastKey = current.key;
          stable = 1;
        }

        lastInfo = current;

        if (
          sawExactQuery &&
          stable >= 4
        ) {
          await sleep(450);

          return {
            state: "rows",
            ...current
          };
        }

        await sleep(300);
      }

      return {
        state: "none"
      };
    }

    /* -------------------------- SEARCH VERIFICATION ---------------------- */

    case "results": {
      const query =
        String(a?.q || "").trim();

      const panel = findPanel();

      const input =
        panel &&
        searchInput(panel);

      if (
        !panel ||
        !input ||
        String(input.value || "").trim() !== query
      ) {
        return null;
      }

      if (!a?.key) {
        return /no results found/i.test(
          txt(panel)
        )
          ? {
              state: "none"
            }
          : null;
      }

      const list = rows(panel);

      if (!list.length) return null;

      const exact = list.find(
        (r) =>
          r.info.key === a.key
      );

      if (exact) {
        return {
          state: "rows",
          ...exact.info
        };
      }

      const title = normalize(a?.title);
      const artist = normalize(a?.artist);

      const matched = list.find((r) => {
        const rt = normalize(r.info.title);
        const ra = normalize(r.info.artist);

        if (
          title &&
          rt === title &&
          artist
        ) {
          return (
            ra === artist ||
            ra.includes(artist) ||
            artist.includes(ra)
          );
        }

        return (
          title &&
          rt === title
        );
      });

      return matched
        ? {
            state: "rows",
            ...matched.info
          }
        : null;
    }

    /* ------------------------------ ADD CLICK ----------------------------- */

    case "addFirst": {
      const expected = a || {};

      const found =
        findResult(expected);

      const panel = found.panel;
      const first = found.row;

      if (!panel) {
        return {
          ok: false,
          error:
            "The Add to playlist panel closed"
        };
      }

      // Always use the LIVE DOM.
      let button =
        first?.b || null;

      if (
        !button ||
        !vis(button) ||
        !document.contains(button)
      ) {
        button =
          findAddButtonFallback(
            expected
          );
      }

      if (!button) {
        return {
          ok: false,
          error:
            "Spotify's live Add button could not be located"
        };
      }

      const before =
        label(button);

      if (isAddedLabel(before)) {
        return {
          ok: true,
          already: true
        };
      }

      /*
       * IMPORTANT:
       * There is only ONE actual add attempt.
       *
       * We do not perform:
       *   - multiple clicks
       *   - click -> retry
       *   - keyboard retry
       *   - DOM-click retry
       *
       * Verification happens outside this operation.
       */

      if (click(button)) {
        await sleep(700);

        return {
          ok: true,
          clicked: true,
          method: "click",
          pending: true
        };
      }

      return {
        ok: false,
        error:
          "Could not activate Spotify's Add button"
      };
    }

    /* ------------------------- EXPLICIT ADD CHECK ------------------------- */

    case "rowState": {
      const expected =
        typeof a === "string"
          ? { key: a }
          : a || {};

      const panel = findPanel();

      if (!panel) {
        return {
          state: "panel-closed"
        };
      }

      const input =
        searchInput(panel);

      if (!input) {
        return {
          state: "unknown"
        };
      }

      const list = rows(panel);

      if (!list.length) {
        return {
          state: "unknown"
        };
      }

      let mine = null;

      if (expected.key) {
        mine =
          list.find(
            (r) =>
              r.info.key ===
              expected.key
          ) || null;
      }

      const title =
        normalize(expected.title);

      const artist =
        normalize(expected.artist);

      if (
        !mine &&
        title &&
        artist
      ) {
        mine =
          list.find((r) => {
            const rt =
              normalize(
                r.info.title
              );

            const ra =
              normalize(
                r.info.artist
              );

            return (
              rt === title &&
              (
                ra === artist ||
                ra.includes(artist) ||
                artist.includes(ra)
              )
            );
          }) || null;
      }

      if (!mine && title) {
        mine =
          list.find(
            (r) =>
              normalize(
                r.info.title
              ) === title
          ) || null;
      }

      // Missing row = UNKNOWN.
      // Never treat it as success.
      if (!mine) {
        return {
          state: "unknown"
        };
      }

      return isAddedLabel(
        label(mine.b)
      )
        ? {
            state: "added",
            info: mine.info
          }
        : {
            state: "available",
            info: mine.info
          };
    }

    /* ---------------------- HANDLE DUPLICATE DIALOG ----------------------- */

    case "outcome": {
      const dialog =
        document.querySelector(
          '[role="dialog"]'
        );

      if (
        !dialog ||
        !vis(dialog)
      ) {
        return null;
      }

      const text = txt(dialog);

      if (
        !/(already|duplicate|added to playlist|in your playlist)/i.test(
          text
        )
      ) {
        return null;
      }

      const skip =
        byLabel(
          /don.?t add|skip|cancel/i,
          dialog
        ) ||
        byText(
          '[role="dialog"] button, [role="dialog"] [role=button]',
          /(don.?t add|skip|cancel)/i
        );

      if (skip) {
        click(skip);

        return "duplicate";
      }

      if (/already/i.test(text)) {
        return "duplicate";
      }

      return null;
    }

    case "playlistCount": {
      const p =
        document.querySelector(
          "main, [data-testid='main'], #main"
        ) || document.body;

      const head =
        txt(p).slice(0, 4000);

      const m = head.match(
        /(\d[\d,]*)\s+songs?\b/i
      );

      return m
        ? +m[1].replace(/,/g, "")
        : null;
    }

    case "escape": {
      for (let k = 0; k < 2; k++) {
        document.dispatchEvent(
          new KeyboardEvent(
            "keydown",
            {
              key: "Escape",
              code: "Escape",
              keyCode: 27,
              which: 27,
              bubbles: true
            }
          )
        );

        await sleep(120);
      }

      return true;
    }

    case "banner": {
      let b =
        document.getElementById(
          "mixvault-banner"
        );

      if (!b) {
        b =
          document.createElement(
            "div"
          );

        b.id =
          "mixvault-banner";

        b.style.cssText =
          "position:fixed;left:50%;bottom:92px;transform:translateX(-50%);z-index:2147483647;padding:10px 18px;border-radius:999px;background:rgba(28,28,30,.88);color:#fff;font:600 13px -apple-system,system-ui,sans-serif;backdrop-filter:blur(14px);box-shadow:0 8px 30px rgba(0,0,0,.35);pointer-events:none";

        document.documentElement.append(b);
      }

      b.textContent = a;

      return true;
    }

    case "unbanner":
      document
        .getElementById(
          "mixvault-banner"
        )
        ?.remove();

      return true;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Worker side                                                                */
/* -------------------------------------------------------------------------- */

async function run(
  tabId,
  op,
  arg
) {
  try {
    const [r] =
      await chrome.scripting.executeScript(
        {
          target: {
            tabId
          },

          func: pageOp,

          args: [
            op,
            arg ?? null
          ]
        }
      );

    const result =
      r?.result;

    console.debug(
      "[MixVault]",
      op,
      arg,
      result
    );

    return result;
  } catch (e) {
    console.error(
      "[MixVault]",
      op,
      arg,
      e
    );

    return undefined;
  }
}

async function until(
  fn,
  ms = 8000,
  every = 300
) {
  const end =
    Date.now() + ms;

  while (
    Date.now() < end
  ) {
    if (ctl.cancelled) {
      throw new Cancelled();
    }

    try {
      const value =
        await fn();

      if (value) {
        return value;
      }
    } catch (e) {
      if (
        e instanceof Cancelled
      ) {
        throw e;
      }
    }

    await sleep(every);
  }

  return null;
}

// Generic act -> verify -> retry helper.
// IMPORTANT:
// We no longer use this helper for adding songs.
// It remains for navigation/search/setup operations.
async function step(
  text,
  act,
  verify,
  {
    tries = 3,
    wait = 8000,
    recover
  } = {}
) {
  note(text, "run");

  let err;

  for (
    let n = 1;
    n <= tries;
    n++
  ) {
    if (ctl.cancelled) {
      throw new Cancelled();
    }

    try {
      await act(n);
    } catch (e) {
      if (
        e instanceof Cancelled
      ) {
        throw e;
      }

      err = e;
    }

    const value =
      await until(
        verify,
        wait
      );

    if (value) {
      note(text, "ok");

      return value;
    }

    if (recover) {
      try {
        await recover(n);
      } catch {}
    }
  }

  note(text, "fail");

  throw new StepError(
    `${text} failed${
      err
        ? ` (${err.message})`
        : ": couldn't be confirmed on the page"
    }.`
  );
}

const queryFor = (t) =>
  `${t.artist} ${t.title}`
    .replace(
      /\s+(ft\.?|feat\.?|featuring)\s+.*$/i,
      ""
    )
    .replace(
      /[()\[\]]/g,
      " "
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim();

export async function runDirect(
  entryId
) {
  if (ctl.running) return;

  ctl.running = true;
  ctl.cancelled = false;

  const keepAlive =
    setInterval(
      () =>
        chrome.runtime.getPlatformInfo(),
      20000
    );

  let tab;
  let playlistId;

  try {
    const {
      library = []
    } =
      await chrome.storage.local.get(
        "library"
      );

    const entry =
      library.find(
        (e) =>
          e.id === entryId
      );

    await startJob({
      entryId,

      name:
        entry?.name ||
        "Playlist",

      via: "direct",

      total:
        entry?.tracks.length ||
        0
    });

    if (!entry) {
      throw new StepError(
        "That playlist is no longer in the library."
      );
    }

    /* ---------------------------- Spotify open --------------------------- */

    const targetUrl =
      entry.spotifyUrl ||
      HOME;

    const existing =
      (
        await chrome.tabs.query({
          url: HOME + "*"
        })
      )[0];

    tab = existing
      ? await chrome.tabs.update(
          existing.id,
          {
            url: targetUrl,
            active: true
          }
        )
      : await chrome.tabs.create({
          url: targetUrl,
          active: true
        });

    chrome.windows
      .update(
        tab.windowId,
        {
          focused: true
        }
      )
      .catch(() => {});

    const loaded =
      async () => {
        const current =
          await chrome.tabs.get(
            tab.id
          );

        return (
          current.status ===
            "complete" &&
          current.url?.startsWith(
            HOME
          )
        );
      };

    await step(
      "Opening Spotify",

      async () => {
        await sleep(700);
      },

      async () =>
        (await loaded()) &&
        (await run(
          tab.id,
          "status"
        ))?.ready,

      {
        tries: 1,
        wait: 25000
      }
    );

    /* ----------------------------- sign in ------------------------------- */

    note(
      "Checking you're signed in",
      "run"
    );

    if (
      !(await until(
        async () =>
          (
            await run(
              tab.id,
              "status"
            )
          )?.loggedIn,
        12000
      ))
    ) {
      throw new StepError(
        "You're not signed in to Spotify. Sign in at open.spotify.com in this browser, then try again."
      );
    }

    note(
      "Checking you're signed in",
      "ok"
    );

    /* -------------------------- playlist setup --------------------------- */

    playlistId =
      await step(
        entry.spotifyUrl
          ? "Opening existing playlist"
          : "Creating a new playlist",

        async () => {
          const current =
            (
              await run(
                tab.id,
                "status"
              )
            )?.playlistId;

          if (current) return;

          if (entry.spotifyUrl) {
            throw new Error(
              "Saved Spotify playlist did not open."
            );
          }

          const result =
            await run(
              tab.id,
              "createPlaylist",
              entry.name
            );

          if (!result?.ok) {
            throw new Error(
              result?.error ||
              "no response from the page"
            );
          }
        },

        async () =>
          (
            await run(
              tab.id,
              "status"
            )
          )?.playlistId,

        {
          tries:
            entry.spotifyUrl
              ? 2
              : 3,

          wait: 12000
        }
      );

    patch({
      url:
        `${HOME}playlist/${playlistId}`
    });

    await until(
      async () =>
        (
          await run(
            tab.id,
            "readPlaylist"
          )
        )?.songs != null,

      8000
    );

    /* ------------------------------ rename ------------------------------- */

    let target;

    try {
      target =
        await step(
          `Naming it “${entry.name}”`,

          async () => {
            if (
              (
                await run(
                  tab.id,
                  "readPlaylist"
                )
              )?.title ===
              entry.name
            ) {
              return;
            }

            const result =
              await run(
                tab.id,
                "rename",
                entry.name
              );

            if (!result?.ok) {
              throw new Error(
                result?.error ||
                "no response from the page"
              );
            }
          },

          async () => {
            const result =
              await run(
                tab.id,
                "readPlaylist"
              );

            return result?.title ===
              entry.name
              ? result.title
              : null;
          },

          {
            tries: 2,
            wait: 6000
          }
        );
    } catch (e) {
      if (
        e instanceof Cancelled
      ) {
        throw e;
      }

      await run(
        tab.id,
        "escape"
      );

      target =
        (
          await run(
            tab.id,
            "readPlaylist"
          )
        )?.title;

      if (!target) {
        throw new StepError(
          "Couldn't read the new playlist's name."
        );
      }

      note(
        `Couldn't rename it, using “${target}”`,
        "warn"
      );
    }

    /* -------------------------- panel management ------------------------- */

    const ensurePanel =
      async () => {
        if (
          await run(
            tab.id,
            "panelOpen"
          )
        ) {
          return true;
        }

        await step(
          "Opening the Add to playlist panel",

          async () => {
            const result =
              await run(
                tab.id,
                "openPanel"
              );

            if (!result?.ok) {
              throw new Error(
                result?.error ||
                "no response from the page"
              );
            }
          },

          () =>
            run(
              tab.id,
              "panelOpen"
            ),

          {
            tries: 3,
            wait: 5000
          }
        );

        return true;
      };

    await ensurePanel();

    /* ------------------------------ songs -------------------------------- */

    for (
      let i = 0;
      i < entry.tracks.length;
      i++
    ) {
      if (ctl.cancelled) {
        throw new Cancelled();
      }

      const track =
        entry.tracks[i];

      const query =
        queryFor(track);

      await patch({
        i: i + 1
      });

      run(
        tab.id,
        "banner",
        `MixVault · adding ${
          i + 1
        } of ${
          entry.tracks.length
        } · please don't click`
      );

      try {
        await ensurePanel();

        // Allow the previous React transaction to settle.
        await sleep(900);

        /* -------------------------- search song -------------------------- */

        let found = null;

        const result =
          await step(
            `Searching “${query}”`,

            async () => {
              found =
                await run(
                  tab.id,
                  "search",
                  query
                );

              if (!found?.state) {
                throw new Error(
                  found?.error ||
                  "no response from the page"
                );
              }
            },

            async () => {
              if (!found) {
                return null;
              }

              return run(
                tab.id,
                "results",
                {
                  q: query,
                  key:
                    found.key ||
                    "",
                  title:
                    found.title ||
                    "",
                  artist:
                    found.artist ||
                    ""
                }
              );
            },

            {
              tries: 2,
              wait: 7000,

              recover:
                async () => {
                  await sleep(350);

                  await ensurePanel();
                }
            }
          );

        if (
          result.state ===
          "none"
        ) {
          J().missed.push(
            `${track.artist} – ${track.title}`
          );

          note(
            `No Spotify result for “${query}”`,
            "warn"
          );

          save();

          continue;
        }

        /*
         * ---------------------------------------------------------------
         * SINGLE ADD ATTEMPT
         * ---------------------------------------------------------------
         *
         * This section intentionally does NOT use:
         *
         *   tries: 4
         *   strikes
         *   retry add
         *   click again
         *   keyboard retry
         *   four-failure shutdown
         *
         * The song gets one Add action.
         * Verification then determines whether it succeeded.
         */

        const expectedCount =
          J().added + 1;

        let addAction;

        try {
          await ensurePanel();

          // Check whether Spotify already reports this exact row as added.
          const state =
            await run(
              tab.id,
              "rowState",
              {
                key:
                  result.key,
                title:
                  result.title,
                artist:
                  result.artist
              }
            );

          if (
            state?.state ===
            "added"
          ) {
            addAction = {
              already: true
            };
          } else {
            /*
             * EXACTLY ONE Add attempt.
             */
            addAction =
              await run(
                tab.id,
                "addFirst",
                {
                  key:
                    result.key,
                  title:
                    result.title,
                  artist:
                    result.artist
                }
              );

            if (!addAction?.ok) {
              throw new Error(
                addAction?.error ||
                "could not click the Add button"
              );
            }
          }
        } catch (e) {
          /*
           * The Add action itself failed.
           * Do NOT try the same song again.
           */
          J().failed.push(
            `${track.artist} – ${track.title}`
          );

          save();

          note(
            `Couldn't add “${result.title}”`,
            "warn"
          );

          continue;
        }

        /* ------------------------- verification -------------------------- */

        /*
         * We still wait for Spotify to finish the ONE add operation.
         *
         * This is NOT another Add attempt.
         *
         * We only observe the page.
         */
        let verified =
          false;

        let duplicate =
          false;

        const verificationEnd =
          Date.now() + 11000;

        while (
          Date.now() <
          verificationEnd
        ) {
          if (
            ctl.cancelled
          ) {
            throw new Cancelled();
          }

          /*
           * 1. Duplicate confirmation.
           */
          const outcome =
            await run(
              tab.id,
              "outcome"
            );

          if (
            outcome ===
            "duplicate"
          ) {
            duplicate = true;
            verified = true;
            break;
          }

          /*
           * 2. Explicit Added / Remove state.
           */
          const row =
            await run(
              tab.id,
              "rowState",
              {
                key:
                  result.key,
                title:
                  result.title,
                artist:
                  result.artist
              }
            );

          if (
            row?.state ===
            "added"
          ) {
            verified = true;
            break;
          }

          /*
           * 3. Playlist song count increased.
           */
          const playlist =
            await run(
              tab.id,
              "readPlaylist"
            );

          if (
            playlist?.songs != null &&
            playlist.songs >=
              expectedCount
          ) {
            verified = true;
            break;
          }

          /*
           * UNKNOWN is NOT success.
           *
           * We simply wait for Spotify's current render to settle.
           * We do NOT click Add again.
           */
          await sleep(500);
        }

        if (verified) {
          if (duplicate) {
            /*
             * Already in playlist.
             * Do not inflate the added count.
             */
            J().dup++;

            note(
              `Already in playlist: “${result.title}”`,
              "ok"
            );
          } else {
            J().added++;

            note(
              `Added “${result.title}”`,
              "ok"
            );
          }

          save();

          /*
           * Let React finish its commit before the next search.
           */
          await sleep(1200);
        } else {
          /*
           * Verification failed.
           *
           * IMPORTANT:
           * Do NOT click the song again.
           * Do NOT retry the add operation.
           * Do NOT increment strikes.
           * Do NOT stop the entire job.
           *
           * Simply record the song as failed and continue.
           */
          J().failed.push(
            `${track.artist} – ${track.title}`
          );

          save();

          note(
            `Couldn't verify “${result.title}” — moving to next song`,
            "warn"
          );

          /*
           * Recover the UI only.
           * This does NOT retry the song.
           */
          await run(
            tab.id,
            "escape"
          );

          await sleep(500);

          await ensurePanel();
        }
      } catch (e) {
        if (
          e instanceof Cancelled
        ) {
          throw e;
        }

        /*
         * Any unexpected error for this individual song:
         *
         * - record failure
         * - do not retry the song
         * - continue to the next song
         */
        J().failed.push(
          `${track.artist} – ${track.title}`
        );

        save();

        note(
          `Failed “${track.artist} – ${track.title}” — moving to next song`,
          "warn"
        );

        await run(
          tab.id,
          "escape"
        );

        await sleep(500);

        try {
          await ensurePanel();
        } catch {}
      }
    }

    /* ---------------------------- final check ---------------------------- */

    const url =
      `${HOME}playlist/${playlistId}`;

    const expected =
      J().added;

    if (!expected) {
      throw new StepError(
        "No songs were added. The empty playlist still exists on Spotify."
      );
    }

    note(
      "Checking the finished playlist",
      "run"
    );

    const seen =
      await until(
        async () => {
          const result =
            await run(
              tab.id,
              "readPlaylist"
            );

          return result?.songs >=
            expected
            ? result
            : null;
        },
        10000,
        400
      );

    if (seen) {
      note(
        `Verified: ${seen.songs} songs on Spotify`,
        "ok"
      );
    } else {
      const actual =
        (
          await run(
            tab.id,
            "readPlaylist"
          )
        )?.songs;

      note(
        `Spotify shows ${
          actual ?? "?"
        } songs, expected ${expected}`,
        "warn"
      );
    }

    const lib =
      (
        await chrome.storage.local.get(
          "library"
        )
      ).library || [];

    const savedEntry =
      lib.find(
        (x) =>
          x.id === entryId
      );

    if (savedEntry) {
      savedEntry.spotifyUrl =
        url;

      savedEntry.spotifyVia =
        "direct";

      await chrome.storage.local.set({
        library: lib
      });
    }

    await patch({
      state: "done",
      url
    });
  } catch (e) {
    if (J()) {
      await patch(
        e instanceof Cancelled
          ? {
              state:
                "cancelled"
            }
          : {
              state: "error",
              error:
                e.message ||
                String(e)
            }
      );
    }
  } finally {
    if (tab) {
      run(
        tab.id,
        "unbanner"
      );
    }

    clearInterval(
      keepAlive
    );

    ctl.running = false;
  }
}
