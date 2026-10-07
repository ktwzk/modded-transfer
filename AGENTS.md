# ModdedTransfer — agent notes

Web MIDI sample uploader for the Model-TG (Elektron sample-transfer protocol,
as in dagargo/elektroid `src/elektron.c`). Single page: `index.html` + `css/` +
`js/`, served as static files (also works from `file://`).

## Sample format (device-facing)

- `size` = PCM bytes **without** the header; `rate` = 48000; `stereo` = 0.
- **32-bit fields are big-endian** (`WIRE_LE=false`; elektroid sends `g_htonl`).
  ⚠️ The one unconfirmed format: an uploaded sample has not been played back
  on the device yet (see “Open questions”). If the device says “Not 48kHz mono”
  when opening an uploaded sample — first try `WIRE_LE = true` and re-upload
  under a new name.
- PCM is signed 16-bit, byte order = same `WIRE_LE`.

### Audio conversion (`decodeToMono48k`)
decodeAudioData (WAV/MP3/M4A/AAC/OGG/Opus/AIFF/AIFC/CAF/FLAC — everything in
`AUDIO_RE`) → manual downmix (mean of all channels) → OfflineAudioContext(1,
frames, 48000) resample → PCM16.
Peak-normalize to 0.99 when `state.normalize` (Normalize checkbox in step 3,
persisted `mt.normalize`, default off; gain logged as `normGain`). The same
converted buffer is uploaded (audition was removed in v23 — the modded Cycles
is a USB audio interface, so the iPad routes playback into the box).
MP4/MOV (via the file input — the same
`isVideoFile → decodeVideoTrack` path: demux + WebCodecs → whole-file
decodeAudioData → real-time capture) → audio track only.
One AudioContext is created per file and closed. No interleaved stereo.

### File pickers (one button everywhere, since v23)
No drop zones — `#pickrow` holds a single `#pickfile` button → `#files`
(the input accepts audio + video; iOS shows its own Photo Library / Take
Video / Choose Files sheet). Drag & drop deliberately lives only in the
official transfer app. The button is busy-guarded in `setControls()`.
`main.js` keeps window-level dragover/drop `preventDefault()` so a stray
drop never navigates away mid-session.

### Rename before upload
The queue keeps File + expando `_target` (default `cleanName(file.name)`:
`/[\\/\\:*?"<>|]/ → _`, trim, 31 chars). Each queued file gets a text input
(`.rename`, `dup` class on collision); `refreshDupeMarks()` updates the marks
in place so the edited input never loses focus. `upload()` sends under
`targetNameFor`, `uploadAll()` stops on duplicate names in the queue; a name
already on the device is caught via `listDir` as before. The Upload button
dims (`dim`) while duplicates exist.

### Design
Inherits Modded-Cycles (18nelli18.github.io/Modded-Cycles): tokens and
Familjen Grotesk (no Tiny5 — there is no LCD drawing in this UI), full-width `.top` header with nav (no hero),
numbered
`.step`s (`.num` turns red via `.done` from `setControls()`),
LCD statuses, key-style buttons, footer. `css/site.css` = page
chrome, `css/app.css` = app components; all JS `#id`s unchanged.

---

## Web MIDI Browser (iOS) gotchas — DO NOT BREAK

Target app: Web MIDI Browser (mizuhiki/WebMIDIAPIShimForiOS). It worked on the
user's iPad — keep the JS syntax level as-is (up to ES2017 `async/await`;
the single `?.` in `selectPort` is tolerated by that iPad — do not add newer
syntax without testing on the device).

1. **`output.send()` — plain Array only, never Uint8Array.** Uint8Array kills
   the native bridge, the whole app closes (not a JS exception!). The format is
   chosen by `sendFmt()`/`wireSend()`; probe results persist in localStorage
   (`mt.sendfmt`, `mt.deadfmt.*`). This is why v12–v14 died on the first send
   (v11 only survived because a different bug meant send was never called).
2. **Web MIDI Maps don't spread** (`[...access.inputs.values()]` →
   `Spread syntax requires ...iterable[Symbol.iterator]`). Port enumeration is
   a forEach → values().next() → Array.from → Object.keys ladder (`mapToList`).
3. **Port id is a number.** Compare only via `String(p.id)`, otherwise
   option.value (“17”) never matches p.id (17) → “No output selected”, buttons
   look dead.
4. **`confirm()`/`prompt()` don't work** — silently return false/null.
   All confirmation/input goes through the in-page `uiDialog()` (promise,
   modal). Symptom if forgotten: “the × button is not clickable”.
5. **The bridge delivers incoming MIDI by calling
   `_callback_receiveMIDIMessage(...)`** via stringByEvaluatingJavaScript.
   Before `requestMIDIAccess` that function doesn't exist in the page →
   ReferenceError on every MIDI-clock tick (~48/s). A stub is defined early,
   logs the argument format once (NATIVE CB FORMAT) and falls back to
   delivering the bytes.
6. **Warm-up:** first `requestMIDIAccess({sysex:false})`, then `{sysex:true}`.
   Don't test in this app without warm-up (checkbox, default on).
7. `ev.data` can be DataView/ArrayBuffer — hence `msgBytes()`.
8. FileList doesn't spread — `Array.from`.
9. The app's Device Config can disable SysEx — then access opens but ports
   are empty.

## MIDI input
MIDI Clock 0xF8 flows constantly. Real-time bytes (F8–FE, FF) are dropped in
any position, **including legally inside SysEx**; 0xF7 is SysEx End, not
real-time. Long SysEx can arrive fragmented — a byte-wise state machine
(`onMidi`, `rxBuf` buffer from F0 to F7).

---

## Probe / diagnostics (`PROBE_STEPS`)
The Probe button is a crash-resumable send-path test: open() → 0xFE/empty
SysEx/identity request/elektron ping in Array and Uint8Array formats. Each
step logs “sending…” → “send() returned” → “STILL ALIVE”. Progress lives in
localStorage: if the app dies, reopen, Connect, Probe resumes after the dead
step and the step's format is marked dead. Ping success → `mt.transport=1`,
and all further TX goes through plain `log()`. “Reset probe” clears it. This
doubles as a differential crash diagnosis: the last log line = where it died.

## Remote logging — REMOVED in v22
The old `GET /?log=` path (batched fetch, opt-in checkbox, `mt.remote` key)
is gone: too many requests on the hoster. `rlog()`/`rlogNow()` are no-op
shells in `core.js` (call sites kept, they send nothing); the original code
survives as a comment. Nothing in the app phones home — verify with
`rg 'fetch\(' js/ index.html` (only hit must be the commented block).

## localStorage keys (`mt.*` since v20; v19 `tg.*` keys are migrated once by
`migrateLs()` and deleted)
`mt.probe.i`, `mt.probe.pending` (step marker — if left over, the app died on
that step), `mt.probe.ok.*`, `mt.sendfmt`, `mt.transport`, `mt.deadfmt.arr`,
`mt.deadfmt.u8`, `mt.warmup`, `mt.verify`, `mt.normalize`, `mt.theme`.

## Code structure (v24: `index.html` + `css/` + `js/`)
`index.html` — markup only (+ tiny theme-init inline script, `mt.theme` with
`tg.theme` fallback for v19 users).
`css/site.css` — page chrome (tokens, base, header, hero, footer);
`css/app.css` — components (steps, LCD, explorer, picker, queue, dialog).
`js/` — plain (NOT module) scripts, loaded at the end of body strictly in
order, sharing one scope (top-level const/let/function visible to later
files):
`core` (guard `window.__MODDED_TRANSFER`, `$`/`state`/constants incl.
`state.connecting`, `state.verify`, `state.normalize`, `state.report`,
`rep()`/`copyReport()`, no-op `rlog`/`rlogNow` (logging removed in v22),
`migrateLs`, bridge stub, `log`/`stage`,
`withBusy`, `uiDialog`) → `protocol` (encode/decode7, frame/unframe,
`sendMsg`, `onMidi`/`handleSysex`) → `midi` (ports, connect with stages
1/6…6/6 + warm-up + re-entry guard, `selectPort` with busy-guard, probe) →
`files` (paths/CP1252, readDir/parse, renderExplorer, recursive delete,
makeDir — all device ops wrapped in `withBusy`, delete/mkdir recorded via
`rep()`) → `queue` (`setControls`,
media types, rename `_target`/`targetNameFor`/`queueDupes`/`refreshDupeMarks`,
renderQueue with per-row `.pfill` bar) → `video`
(MP4/MOV demuxer, WebCodecs, capture) → `audio`
(`decodeToMono48k` with peak-normalize when `state.normalize`, returns
`normGain`; `buildHeader`) → `transfer` (ping, upload with throttled
progress UI (global `#bar` + per-row `#file-bar-N`), optional post-CLOSE
verify via `state.verify`, `uploadAll`) → `main` (bindings
incl. theme toggle, verify/normalize checkboxes, copy-report button, single
`#pickfile` picker, stray-drop guards, error handlers, init). Top-level executable code lives
in `main.js` plus the bridge-stub `try` block and `migrateLs()` definition in
`core.js` (called from `main.js`).

Conventions: all device operations go through `withBusy()` (single-flight +
controls refresh); `selectPort()` refuses port swaps while `busy`; upload
progress UI updates at most ~4 Hz (`showProgress`); keep every new JS feature
at or below the syntax level that runs on the user's iPad (B-group hardening
was deliberately skipped — it works, don't touch).

---

## Status (actually verified on hardware)

✅ Verified by the user on iPad + Model-TG:
- Connect (with warm-up), port selection, Ping, directory listing, navigation,
  mkdir.
- **Upload WAV/MP3**: file appears on the device, size matches byte-for-byte
  (verified after CLOSE via re-READ_DIR).
- Delete after the dialog fix: “seems all good” (files). Recursive folder
  delete (0x12 after emptying) — code exists, protocol from elektroid, not
  explicitly reported.
- App crashes on Connect fixed (Array send + probe).
- **Playing an uploaded sample on the Model-TG** — the main open question
  (see WIRE_LE). Test: upload a 44.1 kHz stereo WAV → open in a track → plays.

⚠️ NOT verified / open:
1. Deleting a folder with contents — run through and confirm.
2. Desktop Chrome/Edge — nominally compatible, not tested in a long time
   (Array-form send is valid there too, probe just passes).
3. Many back-to-back uploads, long files (dozens of WRITE blocks) — bridge
   stability over a long session.

## Known limitations / future work
- Speed: 0x2000 blocks + 20 ms pause. Speed up carefully — the bridge is
  fragile. Keep `deleteRecursive` sequential for the same reason.
- Fragmented MP4 (`moof`, no sample tables) can't be demuxed — clean error,
  needs remux/faststart; documented in README, no code change planned.
- Real-time capture route needs a live playback gesture; iOS may have dropped
  the gesture token by the time the async chain gets there — last resort only.
- Never bring back `confirm`/`prompt`, MIDI-map spreading, raw Uint8Array
  sends bypassing the probe result, and don't touch the `String()` id
  normalization.

## Version history
- v5: response seq from msg[2..3] → dir listing worked
- v7: delete+MP3 — broken (“Not 48kHz mono”, delete silently missing)
- v9: merged with the user's tested build: unpadded encode7, BE fields via
  WIRE_LE, recursive delete 0x12/0x20, IIFE guard
- v10: dark Elektron-style UI → v12: neutral UI, system theme
- v11–v13: WebKit compat (iterators, String()-id, staged connect)
- v14: remote logging + warm-up → diagnosis: crash in send(), not Connect
- v15: probe + Array-form send + `_callback_receiveMIDIMessage` stub → **all working**
- v16: in-page dialog instead of confirm/prompt → × (delete) and New folder work
- v17: remote logging off by default, checkboxes persist
- v18: queue rename (`_target`, `targetNameFor`, `queueDupes`), AAC/OGG/M4A/AIFF
  labels (`AUDIO_RE` already decoded them), MP4/MOV in the file input via the
  `decodeVideoTrack` path, Modded-Cycles step layout
- v19: split the single file into `index.html` + `css/site.css` +
  `css/app.css` + 9 `js/` files (load order in index.html, shared scope, no
  functional changes)
- v20: renamed to **ModdedTransfer** (`mt.*` storage + one-time `tg.*`
  migration); review fixes — single drop hook, connect re-entry guard, styled
  modal primary/danger buttons, dead-CSS purge, focus-preserving rename marks,
  throttled upload progress UI, `withBusy()` single-flight wrapper, port-swap
  guard while busy; AGENTS.md in English + README.md
- v21: UA-dependent file UI — `#pickrow` big buttons (file + Photos) replace the
  drop wells inside WebMIDIBrowser; `#vdrop` hidden on non-Apple devices
- v22: verify-after-upload toggle (`state.verify`/`mt.verify`, skips post-CLOSE
  `listDir` when off), normalize-to-0dB toggle (`state.normalize`/
  `mt.normalize`), per-row ▶ audition (plays the converted buffer, `_conv`
  cache reused by upload), per-file progress bars (`.pfill`), session report
  (`state.report`/`rep()` + Copy report button with clipboard fallback);
  remote server logging REMOVED (no-op `rlog`/`rlogNow`, checkbox + `mt.remote`
   gone — nothing phones home); queue persistence (F3) and on-device rename
   (F7) deliberately skipped (see review: no rename opcode exists)
- v23: audition REMOVED (playback routes into the modded Cycles over USB
  audio, so prelistening is useless) — ▶ button, `toggleAudition`/
  `stopAudition`, `_conv` cache, `.audition` CSS gone; drop zones REMOVED
  (`#drop`/`#vdrop`, `#pick`/`#pickv`/`#videos`, UA switch, section drop
  hook, dead `.drop`/`.well` CSS) — one `#pickfile` button everywhere,
  window stray-drop guards kept
- v24: fixed `readPlane()` in `js/video.js` — interleaved decoder output
  (`f32`/`s16`/`u8` non-planar) was sliced as contiguous channel blocks
  (plus a bytes-vs-elements size mixup), so video audio uploaded
  chopped/garbled while plain audio files (never pass through here) were
  fine; now de-interleaves with stride `i*c+p`, verified by a Node mock-
  AudioData test (8 formats × stereo + mono)
