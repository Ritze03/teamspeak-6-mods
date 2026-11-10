# Mod `files`: compress images

Switch on the mod's card (Settings -> Mods, "Compress images"), **default off**; its page holds the boxes Where, Size and Format. Images over the upload limit are scaled down to a maximum
resolution and re-encoded at the **highest quality that still fits** (binary search), in the page, with the browser's own codecs
(`createImageBitmap(file, {imageOrientation: 'from-image'})` plus `OffscreenCanvas.convertToBlob`). No system dependency. A toast
reports original -> new size, resolution, format and quality. API background: [ts6-mod-api.md](ts6-mod-api.md). Code:
`panel/mods/files/index.js` (policy, settings), `panel/core/x-files.js` (all TeamSpeak names, `api.files`, test seam),
`tools/cdp/mods-inject.mjs:readImage` (path reader).

## Upload routes: what exists, what the mod covers

Probed on the client UI bundle and live. The client's own limits are **5,000,000 B for drag and drop into a chat** and **5,242,880 B for
paste**; the chat attach button has no client-side size check (the stock error text says "use the file picker for bigger files").

| Route | How the client uploads | Client limit | Where it exists | Covered |
|---|---|---|---|---|
| Chat drag and drop | JS `File` -> data URL preview -> `file_cache.upload` | 5,000,000 B (rejects) | chats of a TS6 account (Matrix-based rooms / DMs) | yes |
| Chat paste | clipboard `File` -> data URL preview | 5,242,880 B (rejects) | same | yes |
| Chat attach button | native file dialog -> **path string** preview -> `file_cache.upload(path)` | none | same | yes (path read by the injector binding) |
| Channel / client **Files tab** drag and drop | JS `File` -> `model.uploadFileByData` -> TS3 file transfer | none client-side (server quota / permissions) | every TS3 server | yes |
| Files tab upload button | native dialog -> paths -> native upload (`uploadFilesByPath`) | none client-side | every TS3 server | yes (same reader) |
| Server/channel icons, avatars | own dialogs, own limits | - | - | no |

**On a TS3 server (the user's real server is a TS3 3.13.8 one) the channel chat and the private chat have no attach button and accept
no files** (composer `hasFileUploadAction` is false: `disableFiletransfer`). Images get there only through the **Files tab**. That is why the
mod covers the Files tab, with the same threshold (the Files tab has no client limit, so "over the limit" there means "over the mod's
`Compress images larger than`", default 5 MB). The chat routes only matter in TS6 account chats; they could not be exercised against a real
chat room here (no account), so they are verified up to the composer's preview chip (what gets uploaded when the message is sent).

## Settings (Settings -> Mods -> Compress images card -> its page)

| Setting | Default | Meaning |
|---|---|---|
| Chat attachments / Files tab | on / on | which routes the mod handles (only while the mod is on) |
| Compress images larger than | 5 MB | threshold and size target. Chat drop and paste are additionally capped by the client's own limits, whatever is set |
| Maximum resolution (long edge) | 2560 px | larger images are scaled down first (aspect ratio kept) |
| Target size margin | 5 % | result is aimed this far below the limit |
| Output format | JPEG | JPEG or WebP |
| Transparent images | WebP | WebP (keeps alpha, quality search), PNG (keeps alpha, lossless: no quality to search, so the resolution shrinks by 15 % steps until it fits), White background (flatten, then the chosen format) |

Metadata: the canvas re-encode **always strips** EXIF, GPS and the colour profile (so there is no switch); orientation is applied to the pixels
first. Left untouched: animated GIF (not a handled type), animated PNG (`acTL` chunk) and animated WebP (`ANIM`), SVG and other types,
non-images, images at or under the limit.

## Mechanism

- `api.files.hook({wants, process, vanillaLimit, notify})` (x-files.js) intercepts the five routes and is fully undone on disable (listeners,
  instance patches, DOM observer). The mod supplies the policy; the x-file knows the routes.
- Drop/paste: capture-phase `drop`/`paste` listeners on the document. Only when a dropped/pasted file is a wanted image does the mod swallow the
  event, compress, and add the result with the composer's own `onDraggedFileBlob`; anything else reaches the stock handlers unchanged.
  Oversized non-images in such a mixed drop are skipped with a hint (the stock handler would have rejected the whole drop).
- Attach button / Files tab button: the instance method (`displayInlineFilePicker`, model `uploadFilesByPath`) is replaced while the mod is on;
  the replacement opens the same native dialog, sends non-image / small files on the stock path route and compresses the rest (chat: data URL
  preview; Files tab: `uploadFileByData` with the compressed `File`). Retries (explicit paths) are not touched.
- Files tab drop: the model's `uploadFileByData` is wrapped (`api.onDom` finds the Files tab views).
- Algorithm (`compress`): scale to `maxRes`; try quality 0.98; if too big try 0.40; if that fits, 7 bisection steps between them keep the
  best fit; if even 0.40 is too big, shrink the resolution by 15 % and repeat. Quality is capped at 0.98 (above it the size explodes for no
  visible gain). Alpha is probed on the downscaled canvas.

### Reading picker paths (injector binding `ts6modReadImage`)

The page cannot read a path: `fetch`/XHR of `file://` fail, and the client's `readFileContent` rejects every path with `ParameterInvalid`
(1538; apparently an allowlist). The injector therefore exposes a **narrow, read-only** binding (`tools/cdp/mods-inject.mjs`):
only regular files (`realpath` + `lstat`, symlinks are resolved before the check), only **image magic bytes** (PNG, JPEG, WebP, GIF, BMP, the
extension is ignored), size cap 200 MB, chunked (8 MB max per call, base64), never lists directories, never writes. Reply goes to
`window.__ts6modImgReply`. Only `x-files.js` calls it. Without the injector (client not started via `launcher/ts6-mod`) picker paths stay
uncompressed (stock behaviour) and the settings page says "path reader missing".
Why: the alternatives were a temp-file endpoint in `native/` (C, writes files) or a generic file reader; a magic-byte-checked image reader
in the Node injector is the smallest thing that cannot be turned into reading arbitrary files.

## Why

- JS `File` substitution instead of a native temp file: drop/paste/Files-tab-drop hand over a `File`/data URL, so nothing outside the page
  is needed; only picker paths needed any native help, and there reading is enough because a compressed result goes back in as a data URL.
- Capture-phase swallow instead of patching the stock handlers: the size checks run *before* the composer is reached, and the stock drop is a
  `v-dnd` directive whose handler is bound once; instance patches would not take. The directive counts dragenter/dragleave and resets on drop, so
  after swallowing a drop the mod sends one `dragleave` (coordinates 0/0 reset its counter) to keep the drop overlay working.
- Files tab included although the brief spoke of "the 5 MB limit": on a TS3 server it is the only place images can be uploaded at all.

## Test procedure

Automatic: `node tools/test/run-all.mjs --cdp-port <cdp> --control-port <ctl>` (needs a chat displayed; `panel/mods/files/test.mjs` forces the
composer to accept attachments through the test seam `window.__ts6modFilesTest` in `x-files.js`, because a TS3 chat has no attach button).
Checks, with a 1 MB limit and generated noise images: off = stock (7 MB image rejected); on: drop, paste (stock-style name), under-limit image
untouched, GIF untouched, zip untouched (and stock-rejected above 5 MB), alpha PNG per setting (WebP / PNG / white background), output
format WebP, attach button with real files in a temp dir (big compressed, small and text stay paths), reader refuses non-images and system
files, Files-tab stand-in model (drop and button), off again restores the methods and the stock limit, `assertClean`.
Nothing is ever uploaded (the composer's send is never called). When no composer appears within 6 s of opening the own channel
chat, the chat parts are a SKIP and the Files-tab and reader parts still run.

Manual, real images (local-only set, not in the repo): start the client with `launcher/ts6-mod`, open a chat (or force the composer as the
test does), drop each PNG, read `window.__ts6modFilesLog` (original/new size, resolution, quality) and the preview chip. Real-set results
(defaults: 5 MB, 2560 px, JPEG, WebP for alpha):

| File | Original | Sent | Under 5 MB |
|---|---|---|---|
| PNG 17.8 MB | 4128x2304, 17.77 MB | 2560x1429 JPEG q98, 1.22 MB | yes |
| PNG 16.2 MB (noisy1) | 3920x2160 | 2560x1411 JPEG q98, 1.96 MB | yes |
| PNG 16.4 MB (noisy2) | 3920x2160 | 2560x1411 JPEG q98, 2.00 MB | yes |
| PNG 16.0 MB (noisy3) | 3920x2160 | 2560x1411 JPEG q98, 1.96 MB | yes |
| PNG 45.4 MB (noisy) | 11760x2160 | 2560x470 JPEG q98, 0.49 MB | yes |
| PNG 32.9 MB | 11760x2160 | 2560x470 JPEG q98, 0.34 MB | yes |
| generated alpha PNG 27.4 MB | 3200x2400 | WebP with alpha 2560x1920 q98, 4.73 MB | yes |
| same, "PNG" setting | | PNG with alpha 1136x852 (shrunk to fit), 3.58 MB | yes |
| same, "White background" | | JPEG 2560x1920 q95.3, 4.65 MB | yes |
| 800x600 PNG 1.65 MB | | untouched | n/a |
| 6 MB zip | | untouched; the stock drop limit rejects it | n/a |

Compression takes 0.3 to 4 s per image. A real Files-tab upload on the local test server could not be completed: the test user has no upload
permission there (error 2568 "insufficient client permissions" came back from the server after the mod had already substituted the compressed
file; the substitution itself was confirmed on the live Files tab model).

## Known limits

- Chat routes only exist in TS6 account chats; not tested against a real chat room (no account), only up to the preview chip.
- Not covered: drag and drop of images from a web page (URL/data: strings), icons/avatars, whisper/other dialogs.
- Picker paths need the injector binding (see above). Files over 200 MB are never read.
- Quality is capped at 0.98 and never searched above it; PNG output cannot be tuned, it only shrinks the resolution.
- Compression of a large image takes seconds; the result toast appears only when done (no progress toast, to avoid clutter in the notification center).
