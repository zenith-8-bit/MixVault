const SCOPES = "playlist-modify-private playlist-modify-public";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const forgetLogin = () => chrome.storage.session.remove("token");

async function getToken(clientId) {
  const { token } = await chrome.storage.session.get("token");
  if (token && token.clientId === clientId && token.expires > Date.now() + 60000) return token.value;

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const redirect = chrome.identity.getRedirectURL();
  const url = "https://accounts.spotify.com/authorize?" + new URLSearchParams({
    client_id: clientId, response_type: "code", redirect_uri: redirect,
    scope: SCOPES, code_challenge_method: "S256", code_challenge: challenge,
  });
  let result;
  try { result = await chrome.identity.launchWebAuthFlow({ url, interactive: true }); }
  catch (e) { throw new Error("Spotify login failed or was closed. " + (e.message || "")); }
  const code = new URL(result).searchParams.get("code");
  if (!code) throw new Error("Spotify login was cancelled.");

  const r = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, grant_type: "authorization_code", code,
      redirect_uri: redirect, code_verifier: verifier,
    }),
  });
  if (!r.ok) throw new Error("Token exchange failed: " + (await r.text()));
  const d = await r.json();
  await chrome.storage.session.set({ token: { clientId, value: d.access_token, expires: Date.now() + d.expires_in * 1000 } });
  return d.access_token;
}

async function api(tk, path, opts = {}) {
  for (let tries = 0; tries < 5; tries++) {
    const r = await fetch("https://api.spotify.com/v1" + path, {
      ...opts, headers: { Authorization: `Bearer ${tk}`, "Content-Type": "application/json" },
    });
    if (r.status === 429) { await sleep((+r.headers.get("Retry-After") || 2) * 1000); continue; }
    if (!r.ok) {
      const j = await r.json().catch(() => null);
      throw new Error(`${r.status} ${j?.error?.message || r.statusText}`);
    }
    return r.json();
  }
  throw new Error("Spotify rate limit hit, try again in a minute.");
}

async function find(tk, { artist, title }) {
  for (const q of [`track:${title} artist:${artist}`, `${artist} ${title}`]) {
    const d = await api(tk, "/search?" + new URLSearchParams({ q, type: "track", limit: "1" }));
    const hit = d.tracks?.items?.[0];
    if (hit) return hit.uri;
  }
  return null;
}

export async function pushToSpotify(clientId, name, tracks, onProgress = () => {}) {
  if (!clientId) throw new Error("Add your Spotify Client ID in Settings first.");
  const tk = await getToken(clientId);
  const uris = [], missed = [];
  for (let i = 0; i < tracks.length; i++) {
    onProgress(i + 1, tracks.length);
    const u = await find(tk, tracks[i]);
    u ? uris.push(u) : missed.push(tracks[i]);
  }
  if (!uris.length) throw new Error("No matching tracks found on Spotify.");
  const pl = await api(tk, "/me/playlists", {
    method: "POST", body: JSON.stringify({ name, public: false, description: "Captured with MixVault" }),
  });
  const unique = [...new Set(uris)];
  for (let i = 0; i < unique.length; i += 100) {
    await api(tk, `/playlists/${pl.id}/items`, { method: "POST", body: JSON.stringify({ uris: unique.slice(i, i + 100) }) });
  }
  return { url: pl.external_urls?.spotify, added: unique.length, missed };
}
