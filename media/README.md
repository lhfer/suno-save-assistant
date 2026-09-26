# Motion source

A 12.8-second, silent illustration of the save workflow. It uses fictional song data and compressed timing; it is not a live screen recording or a speed claim.

Palette and typography follow DESIGN.md. The timeline is deterministic, uses one paused root, and can be rendered without a Suno account. Local PingFang SC and Georgia fonts are used on macOS; install equivalent CJK fonts or adjust the font declarations when rendering on another OS.

```sh
cd media
npm run check
npm run render
```

Node.js 22+ and FFmpeg are required. HyperFrames is pinned to 0.8.78. The extension itself has no dependency on HyperFrames or GSAP.

The checked composition has zero lint, runtime, layout and motion findings; all 157 sampled text checks pass WCAG AA. The published GIF is a 1000 px-wide, 15 fps export of the same timeline.
