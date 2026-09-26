# Contributing

Thanks for improving the save workflow.

```sh
npm test
npm run check
npm run package
```

Node.js 20+ is enough for the tests. Packaging uses Python 3. Regenerating the synthetic test fixture additionally needs FFmpeg.

Keep these behavior contracts intact:

- Save only songs the user can normally play. Do not add protected-media bypasses or silently call paid/official export endpoints.
- Never mark a save complete until Chrome confirms the expected file exists and its size matches.
- Preserve queue recovery, canonical song deduplication and the user's foreground tab choice.
- Test invalid/truncated media and cancellation, not only the happy path.
- Keep release packages free of private histories, real song URLs, account data and local filesystem paths.

The extension code is in `extension/`. `docs/` is a static, simulated demo; it cannot access Suno or download real songs. Motion source is in `media/`.

For a browser-dependent change, include a real Chrome acceptance summary: version, expected duration, actual file size, integrity result and complete audio decode. Do not upload private songs or authentication data with the report.
