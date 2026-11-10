/* Chat mod: split long messages. Docs: superdoc/features/mod-chat.md.
 *
 * Two halves in one file (the bundler injects only index.js + style.css, see tools/cdp/bundle.mjs):
 *   1. the PURE splitter (splitMessage / splitParts / byteLength): no DOM, no api. Node loads it through the guarded
 *      module.exports at the bottom (panel/mods/chat/split.test.mjs);
 *   2. the mod itself (ts6mod.register), which only runs inside the injected page (ts6mod is undefined in Node).
 */

/* ===================================================================================================================
 * Splitter. Unit of the limit: UTF-8 bytes of the raw text (measured on the real server: characters and UTF-16 units
 * are NOT what is counted, see the doc page). Code fences (``` or ~~~) are never broken: a block that has to be cut is
 * closed with the same fence and reopened (same fence characters + info string) at the start of the next part.
 * =================================================================================================================== */
const MIN_FILL = 0.25;                       // a paragraph / line boundary is only taken if the part is at least 25% full
const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function byteLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; } else n += 3;
  }
  return n;
}

/* Size on the wire: the command protocol escapes space, newline, tab, backslash, slash and pipe (and a few control characters)
 * as two bytes. The server enforces a second, larger limit on this escaped size (see the doc page). */
const ESCAPABLE = /[ \n\r\t\\\/|\x07\x08\x0b\x0c]/g;
const escapedLength = s => byteLength(s) + (s.match(ESCAPABLE) || []).length;

/* splitParts(text, {limit, escLimit}) -> [{text, body, gap, prefix, suffix}]
 *   text   = prefix + body + suffix: the message to send; prefix = reopened fence, suffix = closing fence (both '' if none)
 *   body   = the slice of the original text this part carries; gap = the original whitespace dropped after it
 *   so  parts.map(p => p.body + p.gap).join('') === text   (exact rejoin) */
function splitParts(text, opts) {
  text = String(text == null ? '' : text);
  const limit = Math.floor((opts && opts.limit) || 8192), escLimit = Math.floor((opts && opts.escLimit) || Infinity);
  if (!(limit >= 16)) throw new RangeError('splitMessage: limit must be at least 16 bytes');
  if (byteLength(text) <= limit && escapedLength(text) <= escLimit) return [{ text, body: text, gap: '', prefix: '', suffix: '' }];

  const N = text.length;
  // cumulative UTF-8 byte offsets per UTF-16 index (a surrogate pair is booked on its high unit, never cut in between)
  const cum = new Uint32Array(N + 1);
  for (let i = 0; i < N; i++) {
    const c = text.charCodeAt(i); let b;
    if (c < 0x80) b = 1; else if (c < 0x800) b = 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < N && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { b = 4; cum[i + 1] = cum[i] + 4; cum[i + 2] = cum[i] + 4; i++; continue; } else b = 3;
    cum[i + 1] = cum[i] + b;
  }
  const cumE = new Uint32Array(N + 1);   // escaped size per UTF-16 index (same booking rule)
  for (let i = 0; i < N; i++) {
    const extra = ESCAPABLE.test(text[i]) ? 1 : 0; ESCAPABLE.lastIndex = 0;
    cumE[i + 1] = cumE[i] + (cum[i + 1] - cum[i]) + extra;
  }
  const B = (a, b) => cum[b] - cum[a], Eb = (a, b) => cumE[b] - cumE[a];
  // does body text[a:b] with the given prefix / closing fence stay within both limits
  const fits = (a, b, pr, pe, st) => pr + B(a, b) + (st ? 1 + st.fence.length : 0) <= limit && pe + Eb(a, b) + (st ? 2 + st.fence.length : 0) <= escLimit;

  // lines, with the fence state before every line. An over-long fence line (> limit/4) is treated as plain text so
  // that prefix + suffix can never eat the budget.
  const lines = [], re = /\r?\n/g; let ls = 0, m;
  while ((m = re.exec(text))) { lines.push({ s: ls, e: m.index, n: m.index + m[0].length }); ls = m.index + m[0].length; }
  lines.push({ s: ls, e: N, n: N });
  const L = lines.length, before = new Array(L + 1), type = new Array(L);
  let st = null;
  for (let i = 0; i < L; i++) {
    before[i] = st;
    const ln = text.slice(lines[i].s, lines[i].e), small = B(lines[i].s, lines[i].e) * 4 <= limit;
    let t = st ? 'content' : 'plain', mm;
    if (small && !st && (mm = FENCE_OPEN.exec(ln)) && !(mm[2][0] === '`' && mm[3].includes('`'))) { t = 'open'; st = { ch: mm[2][0], len: mm[2].length, fence: mm[2], opener: ln }; }
    else if (small && st && (mm = FENCE_CLOSE.exec(ln)) && mm[1][0] === st.ch && mm[1].length >= st.len) { t = 'close'; st = null; }
    type[i] = t;
  }
  before[L] = st;
  const blank = i => /^\s*$/.test(text.slice(lines[i].s, lines[i].e));

  // cut candidates: {e: end of the body, next: start of the next body, st: fence open at the cut, level: 3 paragraph, 2 line, 1 word}
  const cands = [];
  for (let i = 1; i < L; i++) {
    const prev = lines[i - 1], cur = lines[i], f = before[i];
    if (f) {
      if (type[i - 1] === 'open' || type[i] === 'close') continue;       // never an empty block / an orphan closing fence
      cands.push({ e: prev.e, next: cur.s, st: f, level: blank(i - 1) || blank(i) ? 3 : 2 });
    } else {
      if (blank(i)) continue;                                            // the cut goes before the next non-blank line
      let e = prev.e; while (e > 0 && /\s/.test(text[e - 1])) e--;
      if (e <= 0) continue;
      let next = cur.s; while (next < cur.e && (text[next] === ' ' || text[next] === '\t')) next++;   // outside a fence the next part starts at its first visible character
      if (type[i] !== 'open' && /^(`{3,}|~{3,})/.test(text.slice(next, cur.e))) next = cur.s;   // ...unless that would turn deeply indented text into a fence
      cands.push({ e, next, st: null, level: (text.slice(e, cur.s).match(/\n/g) || []).length >= 2 ? 3 : 2 });
    }
  }
  for (let k = 0; k < L; k++) {
    if (type[k] === 'open' || type[k] === 'close') continue;
    const ln = lines[k], seg = text.slice(ln.s, ln.e), wre = /[ \t]+/g; let w;
    while ((w = wre.exec(seg))) {
      if (w.index === 0 || w.index + w[0].length >= seg.length) continue;
      cands.push({ e: ln.s + w.index, next: ln.s + w.index + w[0].length, st: before[k], level: 1 });
    }
  }
  cands.sort((a, b) => a.e - b.e);

  // the line holding index e, and the cut state after a hard cut there
  const lineAt = e => { let lo = 0, hi = L - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lines[mid].s <= e) lo = mid; else hi = mid - 1; } return lo; };
  const isBreakBad = e => {   // do not split a surrogate pair, a ZWJ sequence, a combining mark or a variation selector from its base
    if (e <= 0 || e >= N) return false;
    const a = text.charCodeAt(e - 1), b = text.charCodeAt(e);
    if ((a & 0xfc00) === 0xd800 && (b & 0xfc00) === 0xdc00) return true;
    if (a === 0x200d || b === 0x200d || (b >= 0xfe00 && b <= 0xfe0f) || (b >= 0x0300 && b <= 0x036f) || (b & 0xfc00) === 0xdc00) return true;
    return false;
  };
  function hardCut(s, prefixB, prefixE, maxE) {
    let e = Math.min(maxE, N);
    for (;;) {
      if (e <= s) throw new RangeError('splitMessage: cannot make progress');
      let cut = e;
      if (isBreakBad(cut)) { e--; continue; }
      let k = lineAt(cut);
      if (cut > lines[k].e) cut = lines[k].e;                            // inside a CRLF
      let gap = '', next = cut, state;
      const atomic = type[k] === 'open' || type[k] === 'close';
      if ((atomic && cut > lines[k].s && cut < lines[k].e) || (type[k] === 'open' && cut === lines[k].e)) cut = lines[k].s;
      if (cut === lines[k].s && k > 0) {                                  // a line boundary: the newline is the gap
        const pe = lines[k - 1].e;
        if (pe > s) { gap = text.slice(pe, lines[k].s); cut = pe; next = lines[k].s; state = before[k]; }
        else state = before[k];
      } else if (atomic && cut === lines[k].e) state = before[k + 1];
      else state = before[k];
      if (cut <= s) { e--; continue; }
      if (!fits(s, cut, prefixB, prefixE, state)) { e--; continue; }
      return { e: cut, next, st: state || null, gap };
    }
  }

  const parts = []; let s = 0, F0 = null, ci = 0;
  for (;;) {
    const prefix = F0 ? F0.opener + '\n' : '', prefixB = byteLength(prefix), prefixE = escapedLength(prefix);
    if (fits(s, N, prefixB, prefixE, null)) { parts.push({ text: prefix + text.slice(s), body: text.slice(s), gap: '', prefix, suffix: '' }); break; }
    while (ci < cands.length && cands[ci].e <= s) ci++;
    const best = {}; let bestAny = null;
    for (let j = ci; j < cands.length; j++) {
      const c = cands[j];
      if (!fits(s, c.e, prefixB, prefixE, null)) break;
      if (!fits(s, c.e, prefixB, prefixE, c.st)) continue;
      if (/^\s*$/.test(text.slice(s, c.e))) continue;
      best[c.level] = c; bestAny = c;
    }
    const fill = c => Math.max(B(s, c.e) / (limit - prefixB), escLimit === Infinity ? 0 : Eb(s, c.e) / (escLimit - prefixE));
    let pick = null;
    if (best[3] && fill(best[3]) >= MIN_FILL) pick = best[3];
    else if (best[2] && fill(best[2]) >= MIN_FILL) pick = best[2];
    else pick = bestAny;                                                 // the furthest boundary that fits (word, or a small line / paragraph)
    let cut;
    if (pick) cut = { e: pick.e, next: pick.next, st: pick.st, gap: text.slice(pick.e, pick.next) };
    else {
      // largest e whose body fits (binary search on the byte offsets); hardCut then backs off for the suffix / boundaries
      let lo = s + 1, hi = N;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (fits(s, mid, prefixB, prefixE, null)) lo = mid; else hi = mid - 1; }
      cut = hardCut(s, prefixB, prefixE, lo);
    }
    const body = text.slice(s, cut.e), suffix = cut.st ? '\n' + cut.st.fence : '';
    parts.push({ text: prefix + body + suffix, body, gap: cut.gap, prefix, suffix });
    s = cut.next; F0 = cut.st;
    if (s >= N) break;
  }
  return parts;
}

function splitMessage(text, opts) { return splitParts(text, opts).map(p => p.text); }

if (typeof module !== 'undefined' && module.exports) module.exports = { splitMessage, splitParts, byteLength, escapedLength };

/* ===================================================================================================================
 * The mod. All TeamSpeak specifics live in panel/core/x-chat.js (api.chat); this file uses only api.*.
 * =================================================================================================================== */
const MARGIN = 32;                           // bytes kept free below the measured raw limit (8192)
const ESC_LIMIT = 9000;                      // escaped-size budget; measured server limit is about 9150
const DEFAULTS = { delayMs: 0, inputLimit: 40000 };

if (typeof ts6mod !== 'undefined') ts6mod.register({
  id: 'chat',
  title: 'Split long messages',
  description: 'Raises the chat input limit and sends text that is longer than the server accepts as several messages (split at paragraphs, lines or words; code blocks are closed and reopened, never broken).',
  enable(api) {
    const cfg = () => ({ delayMs: +api.storage.get('delayMs', DEFAULTS.delayMs) || 0, inputLimit: +api.storage.get('inputLimit', DEFAULTS.inputLimit) || DEFAULTS.inputLimit });
    api.chat.raiseLimit(() => cfg().inputLimit);   // read again whenever a composer is (re)built or the page changes

    const budget = el => { const o = api.chat.serverLimit(el); return o ? Math.max(64, o - MARGIN) : 0; };
    api.chatInput.onBeforeSend(ctx => {
      if (ctx.kind !== 'chat') return;
      const max = budget(ctx.element); if (!max) return;
      const parts = splitMessage(ctx.text, { limit: max, escLimit: ESC_LIMIT });
      if (parts.length < 2) return;
      api.timeout(() => { api.chat.sendParts(ctx.element, parts, { delayMs: cfg().delayMs }).catch(e => api.toast('Split long messages', 'Sending stopped: ' + (e && e.message || e))); }, 0);
      return false;                          // the original message is replaced by the parts (sent one by one, in order)
    });

    // live hint "will be sent as N parts" while typing
    let lastKey = '';
    const refreshHint = () => {
      if (!api.chatInput.available()) { api.chat.hint(null); lastKey = ''; return; }
      const el = api.chatInput.element(), text = api.chatInput.text(), max = budget(el);
      const key = max + ':' + text;
      if (key === lastKey) return;
      lastKey = key;
      if (!max || (byteLength(text) <= max && escapedLength(text) <= ESC_LIMIT)) { api.chat.hint(null); return; }
      const n = splitMessage(text, { limit: max, escLimit: ESC_LIMIT }).length;
      api.chat.hint('Will be sent as ' + n + ' parts' + (cfg().delayMs ? ' (' + cfg().delayMs + ' ms apart)' : ''), el);
    };
    api.listen(document, 'input', () => api.timeout(refreshHint, 0), true);
    api.listen(document, 'keyup', refreshHint, true);
    api.listen(document, 'paste', () => api.timeout(refreshHint, 50), true);
    api.onDom(refreshHint, { debounce: 120 });
    refreshHint();
  },
  settings(api, box) {
    const { ui } = api;
    const get = (k, d) => +api.storage.get(k, d) || d;
    box.append(
      ui.slider({ label: 'Delay between parts', min: 0, max: 3000, step: 50, unit: 'ms', value: +api.storage.get('delayMs', DEFAULTS.delayMs) || 0,
        help: 'Pause between the parts of a split message. 0 sends them back to back (a flooding server may need a few hundred ms).',
        onInput: v => api.storage.set('delayMs', v) }).el,
      ui.slider({ label: 'Input limit', min: 8192, max: 100000, step: 1000, unit: 'chars', value: get('inputLimit', DEFAULTS.inputLimit),
        help: 'How much text the message box accepts (stock: the server limit, 8192). Applied the next time a chat is shown.',
        onInput: v => api.storage.set('inputLimit', v) }).el,
      ui.note('Messages that fit the server limit are sent untouched. The hint above the message box shows how many parts a long text will become.'));
  },
});
