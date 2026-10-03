# Changelog

## 0.4.2
- Fixed multi-song Spotify playlist insertion.
- Re-discover live result rows immediately before every Add click.
- Match the requested result by its current key/title instead of retaining stale DOM nodes.
- Wait for Spotify React to replace the result row after clicking Add.
- Treat Add -> Remove/Added or result disappearance as successful insertion.
- Prefer row-state verification while the Add-to-playlist panel is open because the playlist header can lag behind.
- Never click a row again once Spotify reports it as already added.
