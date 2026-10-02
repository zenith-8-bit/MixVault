export async function findSource() {
  const tabs = await chrome.tabs.query({ url: ["https://www.youtube.com/*", "https://music.youtube.com/*"] });
  tabs.sort((a, b) => (/list=/.test(b.url) - /list=/.test(a.url)) || (b.lastAccessed - a.lastAccessed));
  return tabs[0];
}

// Injected into the YouTube tab, so it must be self-contained.
export async function scrapeMix(limit) {
  const isYT = location.hostname === "www.youtube.com";
  const SEL = isYT ? "ytd-playlist-panel-video-renderer"
    : "ytmusic-responsive-list-item-renderer, ytmusic-player-queue-item";
  const rows = () => document.querySelectorAll(SEL);
  let last = -1, same = 0;
  while (same < 3 && rows().length < limit) {
    const r = rows();
    r[r.length - 1]?.scrollIntoView();
    await new Promise((res) => setTimeout(res, 900));
    same = rows().length === last ? same + 1 : 0;
    last = rows().length;
  }
  const tracks = [...rows()].map((r) => {
    if (isYT) {
      const t = r.querySelector("#video-title");
      return { title: (t?.getAttribute("title") || t?.textContent || "").trim(), artist: (r.querySelector("#byline")?.textContent || "").trim(), raw: true };
    }
    if (r.tagName.toLowerCase() === "ytmusic-player-queue-item") {
      return { title: r.querySelector(".song-title")?.textContent.trim(), artist: (r.querySelector(".byline")?.textContent || "").split("•")[0].trim() };
    }
    return { title: r.querySelector("yt-formatted-string.title")?.textContent.trim(), artist: r.querySelector(".secondary-flex-columns yt-formatted-string")?.textContent.trim() || "" };
  }).filter((t) => t.title).slice(0, limit);
  const name = isYT
    ? document.querySelector("ytd-playlist-panel-renderer h3 yt-formatted-string, ytd-playlist-panel-renderer .title")?.textContent.trim()
    : document.querySelector("ytmusic-responsive-header-renderer h1 yt-formatted-string, h1")?.textContent.trim();
  return { name: name || "YouTube mix", tracks };
}

const NOISE = /[(\[][^)\]]*(official|video|audio|lyrics?|visuali[sz]er|hd|4k)[^)\]]*[)\]]/gi;
export function split({ title, artist, raw }) {
  if (!raw) return { artist, title };
  const t = title.replace(NOISE, "").replace(/\s+/g, " ").trim();
  const m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/) || t.match(/^(.+?):\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  const ch = artist.replace(/\s*vevo$/i, "").replace(/\bofficial\b/gi, "").replace(/\s*-\s*topic$/i, "").trim();
  return { artist: ch || artist, title: t };
}

const setCapture = (c) => chrome.storage.local.set({ capture: { ...c, at: Date.now() } });

// Runs in the background so closing the popup mid-scan doesn't lose the result.
export async function capture({ name, max }) {
  await setCapture({ state: "run", msg: "Reading the mix…" });
  try {
    const tab = await findSource();
    if (!tab) throw new Error("Open a YouTube mix in a tab first.");
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: scrapeMix, args: [max || 100] });
    const seen = new Set();
    const tracks = result.tracks.map(split).filter((t) => {
      const k = `${t.artist}|${t.title}`.toLowerCase();
      return seen.has(k) ? false : (seen.add(k), true);
    });
    if (!tracks.length) throw new Error("No songs found. Keep the mix panel open on the page.");
    const { library = [] } = await chrome.storage.local.get("library");
    const entry = { id: String(Date.now()), name: name || result.name, date: new Date().toISOString(), tracks };
    library.unshift(entry);
    await chrome.storage.local.set({ library });
    await setCapture({ state: "ok", msg: `Saved ${tracks.length} songs to “${entry.name}”`, id: entry.id });
  } catch (e) {
    await setCapture({ state: "err", msg: e.message });
  }
}
