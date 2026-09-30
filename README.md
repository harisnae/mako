<div align="center">

# MAKO

**An endless shark hunt — a one-button arcade game that runs entirely in your browser.**

[![License: MIT](https://img.shields.io/badge/License-MIT-ff6f59.svg)](./LICENSE)
[![Live Demo](https://img.shields.io/badge/live%20demo-play%20now-2b8f8a)](https://harisnae.github.io/mako/)
[![Dependencies](https://img.shields.io/badge/dependencies-zero-brightgreen)](#technical-overview)
[![Codebase](https://img.shields.io/badge/code-3%20files-blue)](#repository-contents)

*Named after the mako — the fastest shark in the ocean.*

</div>

---

MAKO is a Chrome-Dino-style endless runner, rebuilt for the water. You are a shark
swimming through a mine-strewn ocean: **eat the fish, dodge the mines, keep kicking** —
the moment you touch a mine or a jellyfish, the hunt ends.

The entire game — rendering, physics, audio — is hand-written vanilla JavaScript in
**three files** with **zero dependencies, zero build steps, and zero image or audio
assets**. Every sprite is drawn with code; every sound is synthesized at runtime.

## Features

- **One-button gameplay** — click, tap, or Space; nothing else to learn
- **Procedural everything** — no image or audio files; all art is code-drawn
- **Synthesized sound** — WebAudio effects generated at runtime
- **Dynamic difficulty** — speed, spawn density, and minefield frequency scale with your score
- **The midnight zone** — the ocean darkens as you hunt; bioluminescence keeps hazards visible
- **Persistent records** — best score and mute preference saved locally
- **Desktop + mobile** — 60 fps target, touch-first input, auto-pause on tab switch

<!-- Screenshot placeholder — drop a capture in /screenshots and uncomment:
![MAKO gameplay](screenshots/gameplay.png)
-->

## How to play

| Input | Action |
|---|---|
| **Click / tap** (anywhere) | Kick upward |
| **Space**, **↑** or **W** | Kick upward |
| **P** | Pause / resume |
| Speaker icon (top-right) | Toggle sound |

**Rules of the ocean:**

- **Eat** the gold fish — each one is +1 to your score.
- **Avoid** naval mines and jellyfish — a single touch ends the run.
- The **surface and seabed are safe** — you bounce off them (but mines parked on the seabed are not).
- Your **best score** is saved in your browser.

### Difficulty

Everything scales with fish eaten — eating is the throttle:

| Parameter | Range |
|---|---|
| Scroll speed | 230 → 560 px/s (+10 per fish, capped at 33 fish) |
| Spawn gap | ×1.3 → ×0.75 (shrinks with speed) |
| Abyss darkness | 0 → 100% over 25 fish |
| Seabed minefield frequency | 12% → 25% |

### The midnight zone

As your score climbs, the palette lerps from sunlit shallows to full abyss: god rays
fade out, marine snow appears, and jellyfish glow brighter — bioluminescence keeps
hazards fair in the dark. Kicks stir up glowing motes once you're deep enough.

## Technical overview

### Architecture

| File | Layer | Responsibility |
|---|---|---|
| `index.html` | Structure | Canvas, HUD, three overlay screens, metadata |
| `game.js` | Behaviour | Simulation, rendering, audio, input, persistence |
| `style.css` | Appearance | Design tokens, HUD, overlays, buttons |

Strict separation of concerns, no frameworks, no build step, no ES modules — a plain
script loaded at the end of `<body>` so the DOM is ready when it runs.

### Rendering

- Single `<canvas>` via the Canvas 2D API; every sprite is procedural
  (the shark alone is ~10 code-drawn parts with an articulated jaw and wagging tail)
- Layered painter's algorithm: water → god rays → parallax dunes → silhouettes →
  marine snow → sand → kelp → hazards → fish → shark → particles → popups → surface → vignette
- `devicePixelRatio`-aware sizing (capped at 2×) for sharp rendering on retina screens
- Expensive gradients cached (the vignette is rebuilt only on resize)

### Game loop & timing

- `requestAnimationFrame` with delta-time simulation
- Frame delta clamped to 33 ms — tab-switch spikes can never tunnel objects through each other
- Global **timescale**: on death it eases to 0.12× for slow motion, then recovers
- DOM writes throttled (the depth meter only updates when its value changes)

### Physics

- Buoyancy model: constant gravity + velocity-proportional water drag
- Impulse thrust: each input **sets** vertical velocity (predictable, Flappy-style)
- Soft, damped bounds at the surface and seabed (non-lethal)
- Circle-based collision with 4 px of forgiveness; hazard hitboxes include their
  animation offsets, so what you see is exactly what you hit

### Spawning & difficulty director

- Spawn timer measured in **scrolled pixels**, so spacing scales with speed automatically
- Weighted pattern roll: fish schools (32%) / single mines (38%) /
  seabed minefields (12–25%, grows with score) / jellyfish (remainder)
- Bait always spawns above danger; a guaranteed minimum 260 px gap between patterns

### Audio (100% synthesized)

- WebAudio API — no audio files to host or download
- White-noise buffer + biquad filters + oscillators + exponential gain envelopes
- Four effects: thrust swish, chomp, death boom, new-record arpeggio
- Single master gain node for muting; the context is lazily created on first
  input (autoplay-policy compliant)

### Persistence

- `localStorage`: best score and mute preference survive reloads

### State machine

`menu → playing → dying → over` (+ `paused`)

- Auto-pause when the tab loses visibility (`visibilitychange`)
- 450 ms restart lockout prevents accidental instant restarts

### Input

- One `press()` entry point, routed by the current state
- Pointer Events unify mouse and touch; keyboard auto-repeat is filtered;
  button focus is handled so inputs never double-fire

## Repository contents

```
mako/
├── index.html    # Structure — canvas, HUD, overlay screens
├── game.js       # Behaviour — simulation, rendering, audio, input
├── style.css     # Appearance — theme tokens, HUD, overlays
├── LICENSE       # MIT
└── README.md     # You are here
```

**What to expect — and what's deliberately absent:**

- No `package.json`, no build tooling, no frameworks, no `node_modules`
- No image or audio assets — the favicon is an inline SVG data URI; all art is code
- Fully commented source: every file opens with an architecture map, and every
  function and rule is explained inline

## Getting started

**Play online:** [harisnae.github.io/mako](https://harisnae.github.io/mako/)

**Run locally:**

```bash
git clone https://github.com/harisnae/mako.git
cd mako
# then open index.html in any modern browser
```

No server or install required — the game is a plain script with no modules or
fetch calls, so it runs straight from the file system.

## Deploy to GitHub Pages

The repository is Pages-ready as-is:

1. Create a repository named **`mako`** and push `index.html`, `game.js` and
   `style.css` to the root of `main`
2. **Settings → Pages → Source: Deploy from a branch** → Branch: `main`,
   Folder: `/ (root)` → **Save**
3. The game goes live at **https://harisnae.github.io/mako/** within a minute or two

## Tuning

All core feel lives in one object at the top of `game.js`:

```js
const CFG={gravity:800,drag:1.8,impulse:-400,baseSpeed:230};
```

| Constant | Default | Effect |
|---|---|---|
| `gravity` | `800` | Downward pull (px/s²) — the shark always sinks |
| `drag` | `1.8` | Water resistance; higher = floatier kicks |
| `impulse` | `-400` | Upward kick velocity (px/s) |
| `baseSpeed` | `230` | Starting scroll speed (px/s) |

The difficulty mix (spawn probabilities, minefield growth) is documented inline
in `spawnPattern()`.

## Browser support

Evergreen **Chrome, Edge, Firefox and Safari**, desktop and mobile. Requires
Canvas 2D, Pointer Events, WebAudio, the Web Animations API and `localStorage` —
all baseline features in modern browsers. `backdrop-filter` blurs the overlay
backdrops and degrades gracefully to a plain dim where unsupported.

## Performance

Designed to hold 60 fps on modest hardware: one canvas, pooled entity arrays,
cached gradients, throttled DOM writes, DPR capped at 2×, and no per-frame
allocations in the hot path beyond small particle spawns.

## Credits

- Fonts: [Bungee](https://fonts.google.com/specimen/Bungee) &
  [Space Mono](https://fonts.google.com/specimen/Space+Mono) via Google Fonts
- Design lineage: the Chrome Dino game and the one-button school of *Flappy Bird*

## License

Released under the [MIT License](./LICENSE) — free to use, modify, and ship,
including commercially. Just keep the copyright notice.
