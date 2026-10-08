# MixVault

> Capture YouTube mixes into a local searchable library and send them to Spotify.

MixVault is a **Manifest V3 Chrome extension** that turns YouTube / YouTube Music mixes into reusable music collections.

The application has two major jobs:

1. **Capture**

   * Detect a YouTube / YouTube Music tab.
   * Read the currently loaded mix/playlist.
   * Extract song titles and artists.
   * Normalize and deduplicate the tracks.
   * Store the result locally as a MixVault library entry.

2. **Export to Spotify**

   * **Direct mode:** control the user's already-signed-in Spotify web session.
   * **API mode:** authenticate through Spotify OAuth and use the Spotify Web API.

The important architectural idea is that the popup is **not responsible for long-running operations**. The popup sends commands to the extension's background service worker, while progress is persisted in `chrome.storage.local` so the UI can reconnect to an operation after updates or popup reopening.

---

# 1. Repository Structure

```text
MixVault/
│
├── manifest.json
│
├── app.html
├── app.css
├── app.js
│
├── background.js
├── capture.js
├── job.js
├── spotify.js
├── spotify-web.js
│
├── fonts/
│   └── figtree.woff2
│
├── icons/
│   ├── 16.png
│   ├── 32.png
│   ├── 48.png
│   └── 128.png
│
└── CHANGELOG.md
```

There is deliberately no framework, bundler, Node.js application, backend server, or database.

The extension is implemented primarily with:

* HTML
* CSS
* Vanilla JavaScript
* Chrome Extension APIs
* YouTube DOM scraping
* Spotify Web UI automation
* Spotify Web API
* `chrome.storage`

---

# 2. High-Level Architecture

```text
                         ┌────────────────────┐
                         │     app.html       │
                         │   Extension UI     │
                         └─────────┬──────────┘
                                   │
                                   ▼
                         ┌────────────────────┐
                         │      app.js        │
                         │ UI + user actions  │
                         └─────────┬──────────┘
                                   │
                         chrome.runtime.sendMessage()
                                   │
                                   ▼
                     ┌─────────────────────────────┐
                     │       background.js         │
                     │ Command/orchestration layer │
                     └───────┬──────────┬──────────┘
                             │          │
                 capture     │          │ Spotify
                             │          │
                             ▼          ▼
                    ┌─────────────┐   ┌─────────────────┐
                    │ capture.js  │   │ job.js          │
                    │ YouTube     │   │ Job state       │
                    │ extraction  │   │ + progress      │
                    └──────┬──────┘   └───────┬─────────┘
                           │                  │
                           ▼                  │
                  chrome.storage.local ◄──────┤
                           │                  │
                           │                  │
                           │          ┌───────┴──────────┐
                           │          │                  │
                           ▼          ▼                  ▼
                       Library   spotify-web.js     spotify.js
                                  Direct mode        API mode
                                       │                 │
                                       ▼                 ▼
                                Spotify Web UI     Spotify Web API
```

The dependency direction is roughly:

```text
app.html
   │
   ▼
app.js
   │
   └── chrome.runtime.sendMessage()
                 │
                 ▼
          background.js
          │     │     │
          │     │     └── spotify.js
          │     │
          │     └──────── spotify-web.js
          │
          └────────────── capture.js

job.js
  ▲
  │
  ├── background.js
  └── spotify-web.js
```

---

# 3. `manifest.json`

## Purpose

`manifest.json` is the entry point and security configuration for the Chrome extension.

It defines:

* extension name/version
* permissions
* allowed websites
* popup
* background service worker

Current version:

```text
0.4.0
```

The extension uses:

```json
"manifest_version": 3
```

The background worker is:

```text
background.js
```

and is loaded as an ES module.

The popup is:

```text
app.html
```

The relevant permissions are:

```text
identity
storage
unlimitedStorage
scripting
```

The host permissions allow communication with:

```text
YouTube
YouTube Music
Spotify
Spotify Web API
Spotify authentication
```

This file therefore controls **what the rest of the application is allowed to do**.

### When modifying functionality

If you add a new external website or Chrome API that requires permission, `manifest.json` is usually the first file that must change.

---

# 4. `app.html`

## Purpose

`app.html` is the popup's static UI structure.

It does **not** contain the application's main logic.

It defines three primary views:

```text
Capture
Library
Settings
```

and an initial onboarding screen.

It also contains:

* Spotify method selector
* YouTube source indicator
* playlist name input
* song limit control
* library search
* library details
* Spotify progress sheet
* toast notification container
* SVG icon definitions

At the bottom:

```html
<script src="app.js"></script>
```

means `app.js` owns the behavior.

---

# 5. `app.css`

## Purpose

`app.css` is purely presentation.

It controls:

* popup dimensions
* typography
* light/dark mode
* cards
* segmented controls
* buttons
* progress sheet
* animations
* library rows
* status indicators
* responsive visual behavior

The application uses the bundled:

```text
fonts/figtree.woff2
```

for its main UI font.

There is no CSS framework.

### Important rule

If you are changing how the application **looks**, start here.

If you are changing what a button **does**, start in `app.js`.

---

# 6. `app.js`

## Purpose

`app.js` is the **frontend controller**.

It connects the HTML interface to the background service worker.

It manages:

```text
UI state
↓
user interactions
↓
Chrome runtime messages
↓
storage updates
↓
UI rendering
```

The central state variables are:

```javascript
let S = {
  method: "direct",
  clientId: "",
  max: 100,
  onboarded: false
};

let lib = [];
let job = null;
let cap = null;
let openId = null;
let view = "capture";
```

These represent:

| Variable | Meaning                        |
| -------- | ------------------------------ |
| `S`      | User settings                  |
| `lib`    | Captured MixVault library      |
| `job`    | Current Spotify export job     |
| `cap`    | Current capture state          |
| `openId` | Currently opened library entry |
| `view`   | Current popup view             |

---

# 7. UI Flow in `app.js`

## Application startup

At the bottom of `app.js`:

```text
chrome.storage.local.get(...)
        ↓
load settings
load library
load job
load capture state
        ↓
render UI
        ↓
show Capture or Onboarding
```

This is important.

The popup does not assume that its JavaScript variables contain the application's real state.

Instead, persistent state is reconstructed from:

```text
chrome.storage.local
```

---

# 8. Capture Button Flow

When the user clicks:

```text
Capture this mix
```

`app.js` executes:

```text
chrome.runtime.sendMessage({
    type: "capture",
    name,
    max
})
```

The popup therefore **does not scrape YouTube itself**.

The request goes to:

```text
background.js
```

which dispatches it to:

```text
capture.js
```

Flow:

```text
app.js
  │
  │ type = "capture"
  ▼
background.js
  │
  ▼
capture()
  │
  ▼
findSource()
  │
  ▼
YouTube tab
  │
  ▼
chrome.scripting.executeScript()
  │
  ▼
scrapeMix()
  │
  ▼
split()
  │
  ▼
deduplicate
  │
  ▼
chrome.storage.local
```

---

# 9. `capture.js`

This file owns the entire **YouTube extraction pipeline**.

It has four important responsibilities.

## 9.1 `findSource()`

```javascript
findSource()
```

searches for:

```text
https://www.youtube.com/*
https://music.youtube.com/*
```

If multiple tabs exist, it prefers a tab that appears to contain a playlist and then uses the most recently accessed tab.

---

# 10. `scrapeMix()`

```javascript
scrapeMix(limit)
```

is the actual YouTube scraper.

An important detail:

> `scrapeMix()` is injected directly into the YouTube page.

It therefore has to be self-contained.

For normal YouTube it looks for:

```text
ytd-playlist-panel-video-renderer
```

For YouTube Music it handles:

```text
ytmusic-responsive-list-item-renderer
ytmusic-player-queue-item
```

The scraper progressively scrolls the list:

```text
find visible rows
      ↓
scroll last row into view
      ↓
wait
      ↓
check row count
      ↓
repeat
```

This is necessary because YouTube uses dynamically loaded lists.

---

# 11. `split()`

YouTube titles are often not clean metadata.

For example:

```text
Artist - Song [Official Video]
```

needs to become:

```text
artist = Artist
title  = Song
```

`split()` performs this normalization.

It removes common noise such as:

```text
Official
Video
Audio
Lyrics
Visualizer
HD
4K
```

It also attempts to identify artist/title separators such as:

```text
Artist - Title
Artist: Title
```

If the title cannot be split reliably, the channel/byline is used as the artist.

---

# 12. Deduplication

After scraping:

```javascript
const tracks = result.tracks.map(split).filter(...)
```

MixVault creates a key:

```text
artist|title
```

and converts it to lowercase.

This prevents duplicate tracks from being inserted into the same captured mix.

---

# 13. Library Storage

A captured mix becomes an object similar to:

```javascript
{
  id: "...",
  name: "...",
  date: "...",
  tracks: [
    {
      artist: "...",
      title: "..."
    }
  ]
}
```

The object is inserted into:

```text
chrome.storage.local
```

under:

```text
library
```

Later, Spotify integration adds fields such as:

```javascript
spotifyUrl
spotifyVia
```

to the same library entry.

This is an important architectural relationship:

```text
capture.js
     │
     ▼
library entry
     │
     ├── app.js displays it
     │
     ├── spotify-web.js consumes it
     │
     └── spotify.js consumes it
```

---

# 14. `background.js`

This is the extension's **orchestration layer**.

It imports:

```javascript
import { ctl, J, startJob, patch, note, save } from "./job.js";
import { capture } from "./capture.js";
import { runDirect } from "./spotify-web.js";
import { pushToSpotify } from "./spotify.js";
```

This gives us the central relationship:

```text
background.js
├── capture.js
├── job.js
├── spotify-web.js
└── spotify.js
```

It listens for messages from the popup:

```text
capture
direct
api
cancel
```

and routes them accordingly.

---

# 15. Background Message Router

The central dispatcher is effectively:

```text
capture → capture()
direct  → runDirect()
api     → runApi()
cancel  → ctl.cancelled = true
```

This makes `background.js` the bridge between:

```text
Popup UI
```

and

```text
Long-running extension operations
```

---

# 16. Why the Background Worker Exists

Spotify operations can take much longer than the lifetime of a popup.

Therefore:

```text
Popup
  ↓
send command
  ↓
Background worker
  ↓
long-running job
```

The popup can then close and reopen while the job state remains available through:

```text
chrome.storage.local
```

The background worker also keeps itself alive during long operations by periodically calling:

```javascript
chrome.runtime.getPlatformInfo()
```

---

# 17. `job.js`

`job.js` is the shared **Spotify job-state manager**.

It is intentionally small.

It provides:

```javascript
ctl
J()
startJob()
patch()
note()
save()
```

The state looks approximately like:

```javascript
{
  state: "run",
  i: 0,
  total: 100,
  added: 0,
  dup: 0,
  missed: [],
  failed: [],
  log: [],
  entryId: "...",
  name: "...",
  via: "direct"
}
```

---

# 18. Why `job.js` Matters

Both Spotify implementations need to communicate progress to the popup.

Instead of duplicating progress logic:

```text
spotify-web.js
       │
       ├── patch()
       ├── note()
       └── save()
                │
                ▼
       chrome.storage.local
                │
                ▼
             app.js
```

The popup listens for storage changes:

```javascript
chrome.storage.onChanged
```

and automatically redraws the progress sheet.

Therefore:

```text
Spotify worker
      ↓
job.js
      ↓
chrome.storage.local
      ↓
app.js
      ↓
progress UI
```

---

# 19. Spotify Integration

MixVault has two completely different Spotify implementations.

```text
                    Spotify export
                         │
             ┌───────────┴───────────┐
             │                       │
          Direct                     API
             │                       │
             ▼                       ▼
    spotify-web.js             spotify.js
             │                       │
             ▼                       ▼
     Spotify Web UI           Spotify Web API
```

This distinction is important when debugging.

If playlist creation/search/clicking is broken:

```text
spotify-web.js
```

is probably responsible.

If OAuth/API requests/rate limits are broken:

```text
spotify.js
```

is probably responsible.

---

# 20. `spotify.js` — API Mode

This file implements the official Spotify API route.

The authentication mechanism is:

```text
Spotify OAuth Authorization Code
+
PKCE
```

The flow is:

```text
app.js
  │
  │ API selected
  ▼
background.js
  │
  ▼
runApi()
  │
  ▼
pushToSpotify()
  │
  ▼
getToken()
  │
  ▼
Spotify OAuth
  │
  ▼
access token
  │
  ▼
Spotify Search API
  │
  ▼
Spotify Playlist API
```

---

# 21. API Authentication

`spotify.js` creates:

```text
code verifier
       ↓
SHA-256 challenge
       ↓
Spotify authorization URL
       ↓
chrome.identity.launchWebAuthFlow()
       ↓
authorization code
       ↓
token endpoint
       ↓
access token
```

The token is stored in:

```text
chrome.storage.session
```

rather than persistent local storage.

This means the authentication state is intentionally session-oriented.

---

# 22. API Track Matching

For every captured track, `find()` tries:

```text
track:<title> artist:<artist>
```

and then:

```text
<artist> <title>
```

It requests one Spotify result.

If a result exists:

```text
Spotify track URI
```

is collected.

If not:

```text
missed[]
```

is updated.

---

# 23. API Playlist Creation

After matching tracks:

```text
POST /me/playlists
```

creates the playlist.

The playlist is private and receives:

```text
Captured with MixVault
```

as its description.

Track URIs are then inserted in batches of:

```text
100
```

Spotify's response URL is saved back into the corresponding MixVault library entry.

---

# 24. API Rate Limiting

`spotify.js` explicitly handles:

```text
HTTP 429
```

It reads:

```text
Retry-After
```

and waits before retrying.

There is also a maximum retry count.

This logic should remain isolated in `spotify.js`; it should not be duplicated in the UI.

---

# 25. `spotify-web.js` — Direct Mode

This is the largest and most complex file in the project.

Its purpose is completely different from `spotify.js`.

It does **not** call Spotify's playlist API.

Instead, it controls the user's existing:

```text
open.spotify.com
```

tab.

The browser becomes the automation interface.

---

# 26. Direct Mode Architecture

```text
background.js
      │
      ▼
runDirect()
      │
      ▼
Find/create Spotify tab
      │
      ▼
run(tabId, operation)
      │
      ▼
pageOp()
      │
      ▼
Spotify DOM
```

The implementation intentionally keeps individual DOM operations small.

Examples include:

```text
status
createPlaylist
readPlaylist
rename
openPanel
panelOpen
search
results
rowState
addFirst
outcome
escape
banner
unbanner
```

This is essentially a small RPC layer between the background service worker and the Spotify webpage.

---

# 27. `pageOp()`

`pageOp()` executes operations **inside the Spotify page**.

Because Spotify is a React SPA and its DOM changes dynamically, the implementation contains helpers for:

```text
visibility detection
text matching
ARIA labels
test IDs
waiting for elements
click simulation
input manipulation
```

The locator strategy generally prefers:

```text
data-testid
ARIA attributes
semantic elements
```

before falling back to DOM structure.

This is important because Spotify's UI can change.

---

# 28. Direct Playlist Flow

The direct implementation follows this sequence:

```text
1. Open Spotify
       ↓
2. Verify page loaded
       ↓
3. Verify user is logged in
       ↓
4. Create or reopen playlist
       ↓
5. Rename playlist
       ↓
6. Open Add to Playlist panel
       ↓
7. Process every song
       ↓
8. Verify final playlist
       ↓
9. Save Spotify URL
       ↓
10. Mark job complete
```

---

# 29. Per-Song Direct Flow

Each track follows:

```text
Captured track
      ↓
queryFor()
      ↓
Spotify search
      ↓
verify search result
      ↓
check whether already added
      ↓
click (+)
      ↓
verify result
      ↓
update job state
```

The important principle is:

> **Act → Verify → Retry**

The code does not simply click a button and assume it worked.

---

# 30. The `step()` Abstraction

One of the most important functions in `spotify-web.js` is:

```javascript
step(text, act, verify, options)
```

Conceptually:

```text
start step
   ↓
perform action
   ↓
poll verification
   ↓
success?
 ┌─┴─┐
yes  no
 │    │
 ▼    ▼
next retry/recover
```

After the configured number of attempts:

```text
step failed
```

This abstraction is responsible for making the Spotify automation more resilient.

---

# 31. Why Verification Exists

Spotify is a dynamic web application.

A click can technically execute while:

* the page is still rendering
* the button is temporarily stale
* React hasn't updated the UI
* the network request is still pending
* the result panel has not refreshed

Therefore MixVault verifies state using signals such as:

```text
playlist title
playlist song count
row state
panel state
Spotify URL
```

This is one of the most important implementation details in the project.

---

# 32. Direct Mode Duplicate Protection

Direct mode also attempts to avoid adding the same song twice.

Before clicking:

```text
rowState()
```

is checked.

If the row is already in the:

```text
added
```

state, MixVault does not click it again.

There is also logic for interpreting a duplicate result after a retry.

---

# 33. Failure Handling

For each track:

```text
try
   search
   add
   verify
catch
   record failure
   recover page state
   continue
```

If four consecutive songs fail:

```text
stop
```

This is deliberate.

Four consecutive failures are treated as evidence that Spotify's UI has probably changed rather than simply assuming every track is bad.

---

# 34. Final Verification

At the end of Direct mode:

```text
expected = number of successfully added tracks
```

The Spotify playlist is queried again.

If Spotify reports at least that many songs:

```text
Verified
```

Otherwise:

```text
Warning
```

The library entry is then updated with:

```javascript
spotifyUrl
spotifyVia: "direct"
```

---

# 35. Important Shared Data Model

A MixVault library entry starts as:

```javascript
{
  id,
  name,
  date,
  tracks
}
```

After Spotify export it can become:

```javascript
{
  id,
  name,
  date,
  tracks,
  spotifyUrl,
  spotifyVia
}
```

This same object travels through multiple components:

```text
capture.js
    ↓
chrome.storage.local
    ↓
app.js
    ↓
spotify-web.js / spotify.js
    ↓
chrome.storage.local
    ↓
app.js
```

Understanding this data model is essential when modifying the application.

---

# 36. Storage Architecture

MixVault primarily uses two Chrome storage areas.

## `chrome.storage.local`

Used for persistent application data:

```text
settings
library
job
capture
```

Conceptually:

```text
local
├── settings
├── library
├── job
└── capture
```

This survives popup closing.

---

## `chrome.storage.session`

Used for the Spotify API authentication token:

```text
token
```

Conceptually:

```text
session
└── token
```

The API login can therefore be cleared without deleting the MixVault library.

---

# 37. Live UI Updates

The popup listens to:

```javascript
chrome.storage.onChanged
```

This is the application's event bus for background operations.

For example:

```text
background
    │
    │ update capture
    ▼
storage.local.capture
    │
    ▼
chrome.storage.onChanged
    │
    ▼
app.js
    │
    ▼
renderCap()
```

Likewise:

```text
Spotify worker
    ↓
storage.local.job
    ↓
onChanged
    ↓
renderSheet()
```

This is why the UI can display Spotify progress without directly controlling the Spotify operation.

---

# 38. Library UI

Library rendering is entirely handled by:

```text
app.js
```

Main functions:

```text
renderLibrary()
renderDetail()
trackRow()
exportCsv()
sendSpotify()
```

The library supports:

* browsing captured mixes
* searching by playlist/song/artist
* opening a mix
* deleting a mix
* exporting CSV
* sending a mix to Spotify
* reopening a Spotify playlist

---

# 39. CSV Export

`exportCsv()` does not involve the background worker.

It creates the CSV directly in the popup:

```text
library entry
      ↓
Artist,Title
      ↓
Blob
      ↓
temporary object URL
      ↓
download
```

Therefore CSV export is a purely frontend feature.

---

# 40. `sendSpotify()`

This function is the boundary between the library UI and Spotify processing.

It checks:

```text
Is another Spotify job already running?
```

and, for API mode:

```text
Is a Client ID configured?
```

Then it sends:

```text
direct
```

or:

```text
api
```

to `background.js`.

---

# 41. `fonts/`

Contains the bundled Figtree font:

```text
fonts/figtree.woff2
```

Used by:

```text
app.css
```

No JavaScript dependency exists here.

---

# 42. `icons/`

Contains the Chrome extension icon sizes:

```text
16.png
32.png
48.png
128.png
```

Referenced by:

```text
manifest.json
```

---

# 43. `CHANGELOG.md`

Contains the project's release/change history.

This is documentation only and has no runtime dependency.

---

# 44. Complete Feature → File Map

| Feature                  | Main file        | Supporting files          |
| ------------------------ | ---------------- | ------------------------- |
| Popup UI                 | `app.html`       | `app.js`, `app.css`       |
| UI styling               | `app.css`        | `fonts/`                  |
| Onboarding               | `app.js`         | `app.html`                |
| Detect YouTube tab       | `capture.js`     | `app.js`, `background.js` |
| Scrape YouTube           | `capture.js`     | `manifest.json`           |
| Normalize tracks         | `capture.js`     | —                         |
| Deduplicate tracks       | `capture.js`     | —                         |
| Store library            | `capture.js`     | Chrome Storage            |
| Library display          | `app.js`         | `app.html`                |
| Library search           | `app.js`         | `app.html`                |
| CSV export               | `app.js`         | —                         |
| Delete library entry     | `app.js`         | Chrome Storage            |
| Spotify Direct mode      | `spotify-web.js` | `background.js`, `job.js` |
| Spotify API mode         | `spotify.js`     | `background.js`, `job.js` |
| Spotify OAuth            | `spotify.js`     | `manifest.json`, `app.js` |
| Spotify UI automation    | `spotify-web.js` | `job.js`                  |
| Progress tracking        | `job.js`         | `app.js`, Spotify files   |
| Background orchestration | `background.js`  | Every worker module       |
| Persistent settings      | `app.js`         | Chrome Storage            |
| Extension permissions    | `manifest.json`  | —                         |

---

# 45. Complete Runtime Flows

## Capture

```text
User
 │
 ▼
app.html
 │
 ▼
app.js
 │
 │ sendMessage("capture")
 ▼
background.js
 │
 ▼
capture.js
 │
 ├── findSource()
 │
 ├── executeScript()
 │       │
 │       ▼
 │   scrapeMix()
 │
 ├── split()
 │
 ├── deduplicate
 │
 └── save library
        │
        ▼
chrome.storage.local
        │
        ▼
app.js
        │
        ▼
Capture status
```

---

## Direct Spotify

```text
User
 │
 ▼
app.js
 │
 │ "direct"
 ▼
background.js
 │
 ▼
spotify-web.js
 │
 ├── startJob()
 │
 ├── open Spotify
 │
 ├── verify login
 │
 ├── create/open playlist
 │
 ├── rename
 │
 ├── open Add panel
 │
 ├── search each track
 │
 ├── add result
 │
 ├── verify
 │
 └── final verification
 │
 ▼
job.js
 │
 ▼
chrome.storage.local
 │
 ▼
app.js
 │
 ▼
Progress sheet
```

---

## API Spotify

```text
User
 │
 ▼
app.js
 │
 │ "api"
 ▼
background.js
 │
 ▼
runApi()
 │
 ▼
spotify.js
 │
 ├── OAuth / PKCE
 │
 ├── search tracks
 │
 ├── create playlist
 │
 ├── add URIs
 │
 └── return playlist URL
 │
 ▼
background.js
 │
 ▼
library.spotifyUrl
 │
 ▼
app.js
```

---

# 46. Where to Modify the Code

## I want to change YouTube scraping

Start with:

```text
capture.js
```

Most relevant functions:

```text
findSource()
scrapeMix()
split()
capture()
```

---

## I want to support another YouTube layout

Modify:

```text
scrapeMix()
```

Especially:

```text
SEL
```

and the DOM selectors used to extract:

```text
title
artist
playlist name
```

---

## I want to improve artist/title parsing

Modify:

```text
split()
```

This is independent from the Spotify implementation.

---

## I want to change the library UI

Modify:

```text
app.js
```

Look at:

```text
renderLibrary()
renderDetail()
trackRow()
```

and then modify:

```text
app.html
app.css
```

as necessary.

---

## I want to change Spotify Direct automation

Modify:

```text
spotify-web.js
```

This is the file to inspect first for:

```text
playlist creation
playlist renaming
Spotify search
Add to playlist
duplicate detection
DOM selectors
verification
retry behavior
```

---

## I want to change Spotify API behavior

Modify:

```text
spotify.js
```

Relevant areas:

```text
getToken()
api()
find()
pushToSpotify()
```

---

## I want to change progress behavior

Modify:

```text
job.js
```

and then inspect:

```text
app.js → renderSheet()
```

---

## I want to add a new background command

Modify:

```text
background.js
```

Add a new message type to:

```javascript
chrome.runtime.onMessage.addListener(...)
```

Then have `app.js` send the new message.

---

## I want to add a new Chrome permission

Modify:

```text
manifest.json
```

---

# 47. Debugging Guide

## Capture is not finding YouTube

Check:

```text
capture.js
    ↓
findSource()
```

Then verify the URL matches:

```text
youtube.com
youtube.com/*
music.youtube.com/*
```

---

## Capture finds the tab but gets zero songs

Check:

```text
scrapeMix()
```

The likely problem is a changed YouTube DOM selector.

Inspect:

```text
SEL
```

and the title/artist selectors.

---

## Artist/title are wrong

Do not immediately modify the scraper.

First inspect:

```text
split()
```

because YouTube may be returning the expected raw data and the normalization step may be incorrectly interpreting it.

---

## Spotify Direct creates a playlist but doesn't rename it

Start with:

```text
spotify-web.js
```

Specifically:

```text
rename
readPlaylist
step()
```

The rename operation is considered successful only after the playlist title is read back and matches the requested name.

---

## Spotify Direct searches but doesn't add tracks

Trace:

```text
search()
      ↓
results()
      ↓
rowState()
      ↓
addFirst()
      ↓
outcome()
```

The important code is in `spotify-web.js`.

Do not start by modifying `background.js`.

---

## Spotify Direct creates multiple playlists

Inspect:

```text
runDirect()
```

especially:

```text
entry.spotifyUrl
```

The intended behavior is:

```text
No spotifyUrl
    ↓
create playlist

Existing spotifyUrl
    ↓
reuse existing playlist
```

This prevents repeated runs from creating a new playlist every time.

---

## API login fails

Inspect:

```text
spotify.js
```

and verify:

```text
Client ID
Redirect URI
OAuth configuration
```

Also inspect:

```text
manifest.json
```

for the required Spotify authentication host permissions.

---

## Progress gets stuck

Inspect the chain:

```text
Spotify implementation
        ↓
job.js
        ↓
chrome.storage.local.job
        ↓
app.js
        ↓
renderSheet()
```

The problem is usually somewhere in this chain.

---

# 48. The Most Important Files

If you are returning to this project after a long break, you do **not** need to read every file in order.

Read them in this order:

### 1. `manifest.json`

Understand:

```text
What the extension is
What permissions it has
What starts when the popup opens
What runs in the background
```

### 2. `app.js`

Understand:

```text
How the UI works
What messages it sends
What state it reads
```

### 3. `background.js`

Understand:

```text
How commands are routed
```

### 4. `capture.js`

Understand:

```text
How YouTube → MixVault data works
```

### 5. `job.js`

Understand:

```text
How long-running operations communicate progress
```

### 6. `spotify.js`

Understand:

```text
Official Spotify API path
```

### 7. `spotify-web.js`

Understand last because it is by far the most complex file:

```text
Spotify browser automation
DOM interaction
verification
retry/recovery
```

---

# 49. Mental Model for the Whole Project

The simplest way to remember MixVault is:

```text
                 ┌──────────────┐
                 │   YouTube    │
                 └──────┬───────┘
                        │
                     scrape
                        │
                        ▼
              ┌──────────────────┐
              │     Library      │
              │ chrome.storage   │
              └────────┬─────────┘
                       │
                    choose
                       │
             ┌─────────┴─────────┐
             │                   │
             ▼                   ▼
        Direct Mode          API Mode
             │                   │
             ▼                   ▼
       Spotify Web UI       Spotify API
             │                   │
             └─────────┬─────────┘
                       │
                       ▼
               Spotify Playlist
```

The popup is primarily the **control panel**.

The background worker is the **orchestrator**.

`capture.js` is the **YouTube ingestion pipeline**.

`job.js` is the **shared job-state system**.

`spotify-web.js` is the **browser automation engine**.

`spotify.js` is the **official API integration**.

---

# 50. Design Principles

Several implementation decisions are worth preserving when extending the project.

## Keep long operations out of the popup

Use:

```text
background.js
```

for long-running work.

---

## Persist important state

Use:

```text
chrome.storage.local
```

instead of relying solely on JavaScript variables.

---

## Keep Spotify implementations separate

Do not merge:

```text
spotify.js
```

and:

```text
spotify-web.js
```

They solve fundamentally different problems.

---

## Verify browser automation

For Direct mode, prefer:

```text
act → verify → retry
```

instead of:

```text
click → assume success
```

---

## Keep UI rendering separate from operations

`app.js` should display state.

The worker modules should perform the operations.

The storage layer connects them.

---

# 51. Extension Architecture in One Diagram

```text
┌─────────────────────────────────────────────────────────────┐
│                         MixVault                            │
│                                                             │
│  ┌────────────────── Popup ──────────────────────────────┐ │
│  │                                                       │ │
│  │  app.html ──────────► app.js ──────────► app.css      │ │
│  │                         │                              │ │
│  │                         │ runtime messages             │ │
│  └─────────────────────────┼─────────────────────────────┘ │
│                            ▼                                │
│  ┌───────────────────────────────────────────────────────┐ │
│  │                  background.js                        │ │
│  │                                                       │ │
│  │      ┌──────────────┬──────────────┬─────────────┐   │ │
│  │      │              │              │             │   │ │
│  │      ▼              ▼              ▼             │   │ │
│  │ capture.js      spotify-web.js   spotify.js      │   │ │
│  │      │              │              │             │   │ │
│  │      │              └──────┬───────┘             │   │ │
│  │      │                     │                     │   │ │
│  │      └─────────────────────┼─────────────────────┘   │ │
│  │                            ▼                         │ │
│  │                         job.js                       │ │
│  └───────────────────────────┼─────────────────────────┘ │
│                              │                           │
│                              ▼                           │
│                    chrome.storage.local                 │
│                              │                           │
│                              ▼                           │
│                           app.js                         │
│                              │                           │
│                              ▼                           │
│                         Popup UI                         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

# 52. Development Strategy

When adding a feature, first identify which layer owns it.

```text
Visual change
    → app.css / app.html

Popup behavior
    → app.js

Chrome event/message routing
    → background.js

YouTube extraction
    → capture.js

Persistent job state
    → job.js

Spotify API
    → spotify.js

Spotify browser automation
    → spotify-web.js

Extension capability/permissions
    → manifest.json
```

Avoid putting functionality into `background.js` simply because it is the background worker.

`background.js` should primarily **coordinate** the specialized modules.

---

# 53. Current Architectural Boundary

The most important boundary in MixVault is:

```text
UI
│
├── app.html
├── app.css
└── app.js
        │
        │ messages
        ▼
Runtime
│
└── background.js
        │
        ├── capture.js
        ├── job.js
        ├── spotify-web.js
        └── spotify.js
```

If you understand this boundary, the rest of the repository becomes significantly easier to navigate.

---

# 54. Quick Reference

```text
START HERE
    │
    ▼
manifest.json
    │
    ▼
app.js
    │
    ▼
background.js
    │
    ├──────────────► capture.js
    │                    │
    │                    └── YouTube → Library
    │
    ├──────────────► spotify-web.js
    │                    │
    │                    └── Library → Spotify UI
    │
    ├──────────────► spotify.js
    │                    │
    │                    └── Library → Spotify API
    │
    └──────────────► job.js
                         │
                         └── Progress/state

UI:
app.html + app.css

Assets:
fonts/ + icons/

History:
CHANGELOG.md
```

---

## Repository

[MixVault on GitHub](https://github.com/zenith-8-bit/MixVault)
