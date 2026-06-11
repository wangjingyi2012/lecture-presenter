# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Lecture Presenter（演讲宝）is a Tauri 2 desktop app for presenting course materials: PDF, video, Markdown, source code, and **PPTE (PPT-EXTRA)** — HTML files that simulate PowerPoint slides. All app code lives in `lecture-app/`.

## Commands

All commands run from `lecture-app/`:

```bash
npm install            # install deps (also requires Rust stable + Tauri 2 system deps)
npm run dev            # tauri dev — launches the desktop app with live frontend
npm run build          # tauri build — bundles to src-tauri/target/release/bundle/
npm run build:release  # obfuscated production build (scripts/build-obfuscated.js)
npm run test:ppte      # node scripts/test-ppt-extra-viewer.js (slide URL/platform logic)
npm run test:annotator # node scripts/test-ppte-annotator.js (annotation overlay)
cargo check            # run inside src-tauri/ to type-check Rust
```

There is no bundler, framework, or lint step: the frontend is plain HTML/CSS/JS loaded directly from `lecture-app/src/` (`frontendDist: ../src`). `npm run build:release` copies `src/` to `dist/`, obfuscates non-vendor JS, temporarily patches `tauri.conf.json`, then restores it.

## Architecture

### Frontend (lecture-app/src/)

- `index.html` — single page containing ALL UI: sidebar, content area, and every modal (PDF/video/code/HTML/PPTE viewers, course creator, settings). Modals are `.hidden`-toggled divs.
- `audience.html` — separate Tauri window shown to the audience in speaker mode; receives `slide-change` events and emits `audience-navigate` events back.
- `js/*.js` — plain scripts, each defining one global object (e.g. `PptExtraViewer`, `CourseLoader`, `Content`). No modules/imports; load order is set by `<script>` tags in `index.html`. `app.js` calls each component's `init()` on DOMContentLoaded.
- Frontend ↔ backend via `window.__TAURI__.core.invoke(...)` and `window.__TAURI__.event` — guarded by `if (window.__TAURI__)` so browser dev mode degrades to `fetch`.

### Backend (lecture-app/src-tauri/src/lib.rs)

Single ~2000-line file with all `#[tauri::command]` handlers: file I/O (`read_text_file`, `write_text_file`), course config management, file/folder pickers, PPTE folder creation, AI calls (DeepSeek/MiniMax/LectureAI), audience window management (`open_audience_window`, `emit_slide_change`), and two custom URI scheme protocols:

- `slide://` — serves slide files preserving real path slashes (the built-in asset protocol encodes `/` as `%2F`, breaking relative URLs in slide HTML).
- `media://` — serves video with HTTP Range support.

### PPTE slide loading is platform-split (critical, easy to regress)

- **macOS WebKit**: iframe loads `slide://localhost/<abs-path>` directly.
- **Windows WebView2**: cannot reliably load `slide://` in iframes; instead the HTML is read via `read_text_file`, a `<base href="http://slide.localhost/...">` is injected (`_injectBaseHref` replaces any existing `<base>`), and assigned via `srcdoc`.

Platform detection is `_usesCustomProtocolHost()` in `ppt-extra-viewer.js`. `npm run test:ppte` covers both paths plus `<base>` replacement and Chinese-path URL encoding — run it after touching slide-loading logic. See `memory/2026-06-10-ppte-animation-blank.md` for the debugging history.

### PPTE viewer (js/ppt-extra-viewer.js)

`PptExtraViewer` handles three display states inside `#ppt-extra-modal`:

1. **Normal**: TOC sidebar + slide iframe.
2. **Play mode** (`F`): `playing-mode` class fullscreens the iframe.
3. **Speaker mode** (`S`): hides normal view, shows `#speaker-view` (current/next slide previews, Markdown notes with edit/preview toggle, timer), and opens the separate audience window via Tauri command. Notes are stored per-slide as `.note` files next to the slide HTML.

Navigation events flow from slide iframes via `postMessage({type:'slide-navigate'})` to the parent (`_installFrameNavigation` injects key/click listeners into each frame's document), and from the audience window via the Tauri `audience-navigate` event.

### Annotation overlay (js/ppte-annotator.js)

`PpteAnnotator.create({container, ...})` mounts a transparent canvas + toolbar over a container without touching slide HTML or the platform-split loading. Annotations (pen/highlighter/text/eraser) are memory-only and per-page (`setPage`), discarded on `reset()`. Two instances exist: one over `#ppt-extra-container` (toggled by the header button or `P`), one in `audience.html` (corner floating button) — they are independent, with no cross-window sync by design. When inactive the canvas is `pointer-events:none` so click-to-advance still works.

### Course data model

A course is a folder with `course.json` (schema in `COURSE_FORMAT.md`): `weeks[]` → `resources` (slides/videos/readings/assignments/sourceCode/ppt-extra). A PPTE resource is a directory containing `manifest.json` (`{title, slides:[{file, title}]}`) plus one HTML file per slide. App config (imported course list, settings, API keys) is stored in the OS app-data directory.

## Conventions

- UI strings are Chinese; code comments are English.
- Repo docs: `COURSE_FORMAT.md` (course/PPTE format spec), `PUBLISHING.md` (release process: tag `v*` triggers GitHub Actions builds), `memory/` (debugging reports — append new reports there).
- This is the public GitHub repo; never commit personal courses, API keys, or `.db` files.
