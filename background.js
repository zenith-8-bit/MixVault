import { ctl, J, startJob, patch, note, save } from "./job.js";
import { capture } from "./capture.js";
import { runDirect } from "./spotify-web.js";
import { pushToSpotify } from "./spotify.js";

// If the worker was restarted mid-job, that job is dead: say so instead of showing a stale spinner.
chrome.storage.local.get("job").then(({ job }) => {
  if (job?.state === "run") chrome.storage.local.set({ job: { ...job, state: "error", error: "Interrupted. Please run it again." } });
});

// API method (needs a Client ID); runs here because its login window would close the popup.
async function runApi(entryId) {
  if (ctl.running) return;
  ctl.running = true; ctl.cancelled = false;
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(), 20000);
  try {
    const { library = [], settings = {} } = await chrome.storage.local.get(["library", "settings"]);
    const entry = library.find((e) => e.id === entryId);
    await startJob({ entryId, name: entry?.name || "Playlist", via: "api", total: entry?.tracks.length || 0 });
    if (!entry) throw new Error("That playlist is no longer in the library.");
    note("Signing in and matching songs", "run");
    const r = await pushToSpotify(settings.clientId, entry.name, entry.tracks, (i) => {
      if (ctl.cancelled) throw new Error("Cancelled");
      patch({ i });
    });
    note("Signing in and matching songs", "ok");
    note("Created the playlist", "ok");
    const lib = (await chrome.storage.local.get("library")).library || [];
    const e2 = lib.find((x) => x.id === entryId);
    if (e2) { e2.spotifyUrl = r.url; e2.spotifyVia = "api"; await chrome.storage.local.set({ library: lib }); }
    J().missed = r.missed.map((t) => `${t.artist} – ${t.title}`);
    await patch({ state: "done", added: r.added, url: r.url });
  } catch (e) {
    if (J()) await patch(e.message === "Cancelled" ? { state: "cancelled" } : { state: "error", error: e.message });
  } finally {
    clearInterval(keepAlive);
    ctl.running = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.type === "capture") capture(msg);
  else if (msg.type === "direct") runDirect(msg.entryId);
  else if (msg.type === "api") runApi(msg.entryId);
  else if (msg.type === "cancel") ctl.cancelled = true;
  reply({ ok: true });
});
