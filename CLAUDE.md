# CLAUDE.md

This file provides Claude Code-specific handoff context for this repository.

@AGENTS.md

`AGENTS.md` is the canonical architecture, commands, testing, safety, and repository-boundary document. Read it before changing code. If this file and `AGENTS.md` ever disagree, follow `AGENTS.md` and repair this handoff rather than preserving duplicate instructions.

## Current Handoff (2026-08-14)

LectureAI whole-deck generation now uses the cloud Pi Agent runtime for bounded per-page execution when the desktop workbench model selector is set to **LectureAI**.

```text
Desktop workbench
  <-> authenticated WebSocket
FastAPI /api/web/ai/pi/bridge
  <-> loopback WebSocket
Node Pi Runtime
```

The server owns the model loop, private page-worker rules, JSONL sessions, compaction, resume state, and abort. The desktop owns the open PPTE and executes only local allowlisted tools. Do not move private template contracts into this public repository, and do not make Pi or Node a separate desktop installation requirement.

Important implementation points:

- Desktop orchestration: `lecture-app/src/js/workbench-window.js` (`_runPlannedHarness`, `_runPiHarnessPage`, `_executePiTool`, `_requestStop`).
- Local PPTE execution bridge: `lecture-app/src/js/ppte-workbench-agent.js`.
- Workbench regression coverage: `lecture-app/scripts/test-workbench-window.js`, run with `npm run test:workbench`.
- Web implementation lives in the separate private repository `/Users/jingyi.wang/Documents/workspace/lecture-presenter-public-web`, branch `codex/lectureai-planning`.
- Web bridge implementation: `backend/app/api/chat.py`, `backend/app/api/deps.py`, `backend/app/services/ai/pi_runtime.py`, and `pi-runtime/src/server.js` in that repository.
- WebSocket authentication uses subprotocols `lectureai.pi.v1` and `lectureai.auth.<JWT>`. Never put the JWT in the WebSocket query string because access logs record URLs.
- Every Pi `tool_call.request_id` must be returned unchanged as `tool_result.request_id`.
- Stop must send `stop`, close the active socket, reject the current page promise, and prevent the next planned page from starting.
- Resume identity and progress live in Deck Plan `execution`: `piSessionId`, `piDeckId`, `completedPages`, `summaries`, `stageReviews`, `nextPage`, and `status`.
- Non-LectureAI provider selection intentionally retains the prior client-side worker path.

Current shipped commits:

- Desktop `main`: `6d2a9ef` (Pi WebSocket execution), `9cc5e87` (subprotocol authentication).
- Web `codex/lectureai-planning`: `c36207d` (desktop tool bridge), `186ad1a` (keep tokens out of URLs).

Production and packaging status:

- `https://design.hz-study-system.com/healthz/ready` is healthy.
- Production image verified after deployment: `sha256:de726a2396e358dcefaa775c6f37921ea7b96f2f82d3570a8d334f019e720593`.
- Public WebSocket smoke passed through Nginx with the log-safe URL `/api/web/ai/pi/bridge`.
- `/Applications/Lecture Presenter.app` is the signed arm64 `2.1.0` build containing the subprotocol-auth fix.
- Original application backup: `/Applications/Lecture Presenter.app.backup-20260814-150737`.
- Server rollback source/image: `/opt/lecture-web.pre-ws-20260814-150118` and `lecture-web:pre-ws-20260814-150118`.

Last full verification:

- Web backend: `69 passed`.
- Pi Runtime: `9 passed`.
- Desktop frontend suites, auth, and workbench: passed.
- Rust: `37 passed`, `2 ignored` live-caption tests requiring cloud credentials; Info.plist test passed.

No implementation work is currently left open. The next step is a real user trial in the installed desktop app, especially a long 20-50 page LectureAI deck, observing page quality, teaching progression, progress visibility, stop latency, and resume behavior. See `memory/2026-08-14-lectureai-pi-websocket.md` for the durable session record.
