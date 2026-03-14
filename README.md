# StreamBox — Free Live TV Worldwide

A free, open-source live TV player that streams thousands of publicly available IPTV channels from every country in the world. No subscriptions, no logins, no ads.

**Live Demo:** [tv.geanpaulo.com](https://tv.geanpaulo.com)

---

## Overview

StreamBox aggregates channel and stream data from the [iptv-org](https://github.com/iptv-org/iptv) open database and presents it in a clean, fast, fully responsive interface. It runs entirely in the browser — no backend, no server, no build step required.

---

## Features

- **8,000+ live channels** from countries worldwide, loaded and filtered client-side
- **Country & category filtering** — filter by any country and category (General, News, Entertainment, Sports, Kids)
- **Real-time search** — debounced, index-cached search across channel names and countries
- **Virtual scrolling** — only visible rows are rendered, keeping the UI smooth across all 8,000+ channels
- **HLS playback** via [hls.js](https://github.com/video-dev/hls.js/) with automatic error recovery
- **Collapsible sidebar** — toggle the channel list to focus on the player (desktop/tablet)
- **Suggested channels** panel on mobile, refreshed on every country change or channel switch
- **Custom country dropdown** — searchable, scrollable, replaces native `<select>` for consistent styling
- **Fully responsive** — desktop, laptop, tablet, and mobile layouts with a dedicated bottom nav on small screens
- **About modal** with developer info and PayPal donation link
- **Keyboard shortcuts** — `m` mute, `f` fullscreen, `b` toggle sidebar, `/` focus search

---

## Tech Stack

| Layer | Technology |
|---|---|
| Markup | Semantic HTML5 |
| Styles | Vanilla CSS (custom properties, grid, flexbox) |
| Logic | Vanilla JavaScript (ES2020+, no frameworks) |
| Playback | [hls.js](https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js) |
| Fonts | [Sora](https://fonts.google.com/specimen/Sora) + [JetBrains Mono](https://fonts.google.com/specimen/JetBrains+Mono) via Google Fonts |
| Data | [iptv-org API](https://iptv-org.github.io/api/) — `channels.json`, `streams.json`, `countries.json` |

---

## Project Structure

```
streambox/
├── index.html       # App shell, layout, modal markup
├── style.css        # All styles — tokens, layout, components, responsive
├── app.js           # All logic — data loading, virtual scroll, HLS, filters
└── README.md        # This file
```

---

## Getting Started

No build tools or dependencies to install. Just open the file.

**Option 1 — Open directly:**
```
open index.html
```

**Option 2 — Serve locally** (recommended, avoids CORS on some browsers):
```bash
# Python
python -m http.server 8080

# Node
npx serve .

# PHP
php -S localhost:8080
```

Then visit `http://localhost:8080` in your browser.

---

## How It Works

### Data loading
On startup, StreamBox fetches three JSON files from the iptv-org API in parallel:

```
channels.json   → channel metadata (name, logo, country, category)
streams.json    → stream URLs with online/offline status
countries.json  → country names and flag emojis
```

Channels and streams are merged by channel ID, closed channels and DASH (`.mpd`) streams are excluded, and the result is sorted with online channels first.

### Search index
After loading, each channel object gets pre-lowercased `_nameL` and `_ctnameL` fields. The search filter reads these cached values instead of calling `.toLowerCase()` on every keystroke — avoiding ~16,000 string allocations per search on the full dataset.

### Virtual scroll
The channel list uses a custom virtual scroller. Only the rows visible in the viewport plus a small overscan buffer (~8 rows above and below) are in the DOM at any time. Two permanent spacer elements maintain the correct scrollbar height. On scroll, only the middle rows are swapped via `insertBefore` — the spacers are never destroyed or recreated, eliminating the flicker that `innerHTML = ''` approaches cause.

### Playback
HLS streams are played via hls.js where supported (most browsers). On Safari, native HLS is used via `video.canPlayType('application/vnd.apple.mpegurl')`. Fatal errors trigger a user-facing error overlay with a retry button.

---

## Keyboard Shortcuts

| Key | Action |
|---|---|
| `m` | Toggle mute |
| `f` | Toggle fullscreen |
| `b` | Toggle sidebar (desktop) |
| `/` | Focus search |
| `Esc` | Close dropdown / About modal |

---

## Performance Notes

- Virtual scrolling keeps DOM node count to ~20–30 regardless of list size
- Search is debounced at 120ms and uses pre-lowercased string fields
- Suggestion sampling uses a partial Fisher-Yates shuffle (O(k), k=12) instead of sorting the full array
- Logo images use an error cache (`failedLogos` Set) so failed requests are never retried on scroll repaints
- The grid column transition is disabled at the mobile breakpoint to prevent blank-flash during window resize

---

## Data Source

All channel and stream data comes from the [iptv-org/iptv](https://github.com/iptv-org/iptv) project, a community-maintained collection of publicly available IPTV streams. StreamBox does not host, operate, or control any of the streams. Stream availability depends entirely on the upstream source.

---

## Developer

**Gean Paulo**
Web UI/UX Designer and Developer based in Manila, Philippines. Specializes in crafting high-end digital experiences that blend minimalist aesthetics with functional, high-performance code.

- Website: [geanpaulo.com](https://geanpaulo.com)
- Support: [paypal.me/geanpaulo](https://www.paypal.com/paypalme/geanpaulo)

---

## Support the Project

StreamBox is free and built in spare time. If you find it useful, consider supporting its development:

[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-0070ba?logo=paypal&logoColor=white)](https://www.paypal.com/paypalme/geanpaulo)

---

## License

This project is open source. The code is free to use, modify, and distribute. Channel data is subject to the [iptv-org license](https://github.com/iptv-org/iptv/blob/master/LICENSE).
