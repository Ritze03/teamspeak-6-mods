# Chat mod: split long messages

Mod id `chat` (`panel/mods/chat/`, core extension `panel/core/x-chat.js`). Default **off**. Built on the mod framework,
see [ts6-mod-api.md](ts6-mod-api.md) (slots, `api.chatInput`, core extension files, tests).

## What it does

- Raises the message box's character limit (stock: the server's per-message limit, 8192) so long text can be typed or pasted.
- On send, text longer than the server accepts is split into several messages, sent one after the other through the composer's
  own send path. Boundaries are preferred in this order: paragraph break, line break, space; a single word longer than a
  message is hard-split (never in the middle of a character, emoji or ZWJ sequence).
- **Code blocks are never broken mid-fence.** A block that must be cut is closed (same fence characters and length) at the end
  of a part and reopened with the same fence line (language / info string verbatim) at the start of the next. A cut is never
  placed right after an opening fence or right before a closing fence (no empty blocks).
- A hint above the message box shows "Will be sent as N parts" live while typing (nothing for text that fits).
- A delay between parts, default 0 ms.
- Text that fits the server limit is sent untouched (same path as without the mod).

## Settings (Settings -> Mods -> Chat card -> its page, box Splitting; shown while the mod is on)

| Key (`api.storage`) | Default | Meaning |
|---|---|---|
| `delayMs` | 0 | pause between the parts, 0..3000 ms (read at send time) |
| `inputLimit` | 40000 | how many characters the box accepts (8192..100000); applied the next time a chat is shown |

Off: the original input limit is back, the hint and the send hook are removed, an unfinished multi-part send stops.

## The server limits (measured)

Measured against the local test server (3.13.8) by sending increasing sizes from a real client through the composer and watching
what the second client receives. A message over a limit is **silently dropped** (nothing arrives, no error is shown). There are two limits:

1. **Raw size: 8192 UTF-8 bytes of the typed text.** ASCII 1000..8192 characters arrive, 8193 and 9000 are dropped. 4096 x `é` (8192 bytes)
   arrives, 4097 (8194) is dropped; 2730 x `漢` (8190 bytes) arrives, 2731 (8193) dropped; 2048 x emoji (8192 bytes, 4096 UTF-16 units)
   arrives, 2049 dropped. Characters and UTF-16 units are not what is counted. The stock composer enforces this number itself (its
   `maxInputLength` is the chat's `GetMaxInputLength()`, 8192 here).
2. **Escaped size: about 9150.** The wire protocol writes space, newline, tab, backslash, slash and pipe as two bytes (`\s`, `\n`, ...).
   With 8000 raw bytes of which k are spaces (or newlines), k <= 1150 arrives and k >= 1155 is dropped, i.e. raw + k <= ~9150;
   7000 raw + 2150 spaces also arrives, 9200 and above is dropped. Ordinary code blocks (many spaces and newlines) hit this limit well
   before the raw one: a 8155-byte code part was dropped, an 8000-byte one arrived. Quotes, asterisks, brackets and `"` cost nothing extra.
   Why it matters: counting raw bytes alone makes the splitter produce parts the server drops.
- No other conversion happens: the receiving client's `textMessage` event carries exactly the typed Markdown.

The splitter counts both (`byteLength`, `escapedLength` in `index.js`; options `limit` and `escLimit`). The mod uses
`serverLimit() - 32` (`MARGIN`) for the raw size and `ESC_LIMIT = 9000` for the escaped size, and the reopened/closing fences are counted in every
part. `serverLimit()` is the composer's own limit (`api.chat.serverLimit()`), so a server with another message limit is followed for the raw size;
the escaped limit is a fixed measured constant (it is not exposed by the client; unverified on other servers).
Only server chats (channel / private) are handled; Matrix-style chat rooms have other limits and are left alone.

## Mechanism

- **Splitter** (`panel/mods/chat/index.js`: `splitParts`, `splitMessage`, `byteLength`): pure, no DOM, no api. The bundler injects only
  `index.js` + `style.css`, so the splitter lives in `index.js` and exports itself through a guarded `module.exports` for Node;
  the `ts6mod.register` call is guarded by `typeof ts6mod`. `split.test.mjs` loads it with `createRequire`.
  `splitParts` returns `{text, body, gap, prefix, suffix}` per part: `text = prefix + body + suffix`, and
  `parts.map(p => p.body + p.gap).join('')` equals the input exactly (the gap is the whitespace dropped at the cut), which is how the
  tests check "rejoin gives the original".
  Algorithm: candidate cut points (paragraph / line / word) are precomputed with the fence state at each; for each part the furthest
  candidate whose byte size plus reopen prefix plus closing suffix fits is chosen (paragraph or line only if the part is >= 25% full,
  else the furthest boundary of any kind, else a hard cut). Known limit: a fence line longer than limit/4 bytes counts as plain text.
- **Limit raise** (`api.chat.raiseLimit`, x-file): the composer computes `maxInputLength` and hands it to its editor as a prop, and
  the editor cuts any text longer than that prop. The x-file shadows the computed with an own property on each composer instance
  and forces a re-render; on disable the property is deleted. Why not patch the editor: the property is the only knob, and shadowing is
  undone cleanly.
- **Send** (`api.chatInput.onBeforeSend` + `api.chat.sendParts`): the hook returns `false` for an over-limit text and starts
  `sendParts`, which for each part puts it into the composer, calls its send method, then waits until the composer has emptied itself
  (it clears when the send is acknowledged, so the order is kept) and then `delayMs`. Why not the core's `string[]` return: it has a
  fixed 40 ms gap and no ack wait. The wait for the clear is capped at 2 s per part. Typing in the box while a delayed send runs is
  overwritten by the next part; switching the chat stops the remaining parts.
- **Hint** (`api.chat.hint`): a small element in the strip above the input (where previews live, so the chat area resizes itself);
  refreshed on `input`/`keyup`/`paste` and the debounced DOM callback, recomputed only when text or limit changed.
- Anchors added by `x-chat.js`: `chat.composers`, `chat.hintHost` (both optional: only while a chat is displayed).
  API namespace `api.chat`: `serverLimit(el?)`, `raiseLimit(n | fn)`, `hint(text | null, el?)`, `sendParts(el, parts, {delayMs})`.

## Test procedure

1. `node panel/mods/chat/split.test.mjs` (Node only): every part within the limit, balanced fences in every part, exact rejoin,
   boundary preference, unicode, fences (`~~~`/```` ``` ````/longer/indented/info strings/nested-looking), degenerate cuts, randomised cases
   (`FUZZ=3000 SEED=n` for more).
2. Real client: start a modded client on the local test server and a second plain client in the **same channel** (CDP port in
   `TS6MOD_CHAT_CDP2`, default 9266), then
   `node tools/test/run-all.mjs --cdp-port <cdp> --control-port <ctl> --only chat`. `test.mjs` enables the mod, checks the raised limit,
   types a >12k text with a code block through trusted input events (the hint must say N parts, N from the splitter), presses Enter
   with a 300 ms delay and checks (a) the composer submitted N messages equal to the splitter parts, spaced >= 300 ms, (b) the second
   client received the same N messages in order with arrival gaps >= 300 ms and that, with the added fences removed, they rejoin to the
   original; repeats with delay 0, checks a short message goes out as one unchanged message, then disables and asserts the original
   limit, no hint, `assertClean`. The sending part runs only if the client is connected to 127.0.0.1 (never posts to a real server).
   Elsewhere the hint is checked with `setText` and no typing, and the user's draft is put back afterwards.
3. Typing very long text is slow in TeamSpeak's own editor (about 6 s for 6000 characters even with the mod off, roughly quadratic), so the
   test uses real typing once and `chatInput.setText` for the other runs.

## Known limits

- A server that counts differently from the measured one, or per-connection flood control, may drop or delay parts; the delay setting is
  the tool for that. Sending many large parts back to back can trip the server's anti-flood (a connection/IP block) on small test servers;
  use a delay when sending dozens of parts.
- Inline Markdown (bold, links, inline code) that straddles a cut is not repaired.
