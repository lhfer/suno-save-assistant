# Synthetic audio fixture

`complete.m4a` is a **generated 440 Hz sine wave**, not a Suno song, recording, or user upload. It contains no lyrics, account data, or embedded artwork.

It is 213.2065 seconds long: one stereo Opus audio track, 48 kHz, 107 fragmented-MP4 media fragments and 10,661 samples. The expected song duration is 213.2 seconds; the small difference is the codec's final sample duration.

Regenerate with FFmpeg installed:

```sh
node scripts/generate-fixture.mjs
```

The fixture is committed so `npm test` needs only Node.js. Codec output bytes may vary between FFmpeg versions; the structural assertions remain the acceptance contract. Tests mutate this synthetic file to exercise gaps, repeats, truncation and invalid sample sizes.
