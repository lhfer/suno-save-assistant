# Changelog

## 0.3.0 — 2026-09-26

- Persist unfinished tasks and offer explicit recovery after reload or restart.
- Deduplicate short and canonical links, including tasks already queued or saved.
- Restore foreground focus independently of renderer messages and script injection.
- Update save-button targets when Suno reuses list or heading nodes.
- Add metadata export and stable extension identity for future releases.
- Fix intrinsic Chrome popup width after real-browser review.
- Publish a clean source repository, synthetic test fixture and illustrated documentation.

Core capture behavior remains the accepted 0.2.3 playback-buffer flow: silent initialization, background collection, strict integrity checks and automatic native downloads.
