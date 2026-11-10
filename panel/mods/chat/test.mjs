// Chat mod ("Split long messages"): real-client test. Needs the LOCAL test server: the client under test must be connected to
// 127.0.0.1 (ctx.onTestServer(); otherwise the real typing and sending are skipped, so this can never post to a real server: there the
// hint is checked on text put into the composer's model only, the editor is never typed into, and the draft is put back) and, for the receiving
// checks, a second plain client in the same channel with CDP on TS6MOD_CHAT_CDP2 (default 9266). See
// superdoc/features/mod-chat.md "Test procedure". The pure splitter has its own test: node panel/mods/chat/split.test.mjs
import { createRequire } from 'node:module';
import { connect } from '../../../tools/cdp/cdp.mjs';
const { splitParts, byteLength } = createRequire(import.meta.url)('./index.js');

const MOD = `__ts6mod.mods().get('chat').api`;
const ESC_LIMIT = 9000;   // = ESC_LIMIT in index.js
const HINT = '[data-ts6mod="chat"].mods-chat-hint';

function longText(paragraphWords, codeLines, tail) {   // paragraphs, then a code block that crosses the limit, then more text
  const para = i => `Paragraph ${i}: ` + 'lorem ipsum dolor sit amet consectetur '.repeat(paragraphWords) + 'ünïcode 漢字 😀.';
  const code = Array.from({ length: codeLines }, (_, i) => `console.log("code line ${i} of the block");`).join('\n');
  return [para(1), para(2), '```js\n' + code + '\n```', Array.from({ length: tail }, (_, i) => para(i + 3)).join('\n\n')].join('\n\n');
}

// compare two lists of strings; on a difference say where (the texts are many KB)
function sameTexts(ctx, got, want, msg) {
  let why = '';
  if (got.length !== want.length) why = `${got.length} messages, expected ${want.length}`;
  else for (let i = 0; i < want.length && !why; i++) if (got[i] !== want[i]) { let k = 0; while (got[i][k] === want[i][k]) k++; why = `message ${i + 1} differs at char ${k}: got ${JSON.stringify(got[i].slice(Math.max(0, k - 15), k + 25))} expected ${JSON.stringify(want[i].slice(Math.max(0, k - 15), k + 25))} (lengths ${got[i].length}/${want[i].length})`; }
  ctx.assert(!why, msg + (why ? ' -- ' + why : ''));
}

export default async function (ctx) {
  await ctx.disable('chat');
  ctx.equal(await ctx.eval(`document.querySelectorAll('[data-ts6mod="chat"]').length`), 0, 'no trace while the mod is off');
  await ctx.eval(`__ts6mod.showOwnChannelChat()`);
  await ctx.waitFor(`__ts6mod.anchors.chat.inputs().length > 0`, 'a chat composer is displayed', 8000);
  const stock = await ctx.eval(`__ts6mod.anchors.chat.inputs()[0].maxInputLength`);
  ctx.assert(stock >= 1024, 'stock input limit read: ' + stock);

  const local = await ctx.onTestServer();
  const draft = await ctx.eval(`__ts6mod.anchors.chat.inputs()[0].msg || ''`);
  await ctx.enable('chat');
  await ctx.waitFor(`__ts6mod.anchors.chat.inputs()[0].maxInputLength > ${stock}`, 'the input limit is raised', 4000);
  ctx.assert(await ctx.eval(`__ts6mod.anchors.chat.inputs()[0].maxInputLength >= 40000`), 'raised to the configured limit (default 40000)');
  ctx.equal(await ctx.eval(`${MOD}.chat.serverLimit()`), stock, 'api.chat.serverLimit() still reports the stock (server) limit');

  await ctx.eval(`${MOD}.chatInput.setText('')`);
  const budget = stock - 32, text = longText(32, 140, 1), expected = splitParts(text, { limit: budget, escLimit: ESC_LIMIT });
  ctx.assert(byteLength(text) > stock && expected.length >= 2, `test text is over the limit: ${byteLength(text)} bytes -> ${expected.length} parts`);

  const type = async t => {   // real, trusted typing into the editor
    await ctx.eval(`${MOD}.chatInput.element().focus()`);
    await ctx.cdp.send('Input.insertText', { text: t });
  };
  const enter = async () => { for (const type of ['rawKeyDown', 'keyUp']) await ctx.cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: type === 'rawKeyDown' ? '\r' : undefined }); };

  if (!local) {
    // real server: no typing (text typed into the editor would stay there and could be sent by the user); the hint is checked on the model
    try {
      await ctx.eval(`${MOD}.chatInput.setText(${JSON.stringify(text)}); document.dispatchEvent(new Event('input'))`);
      await ctx.waitFor(`!!document.querySelector('${HINT}')`, 'hint appears', 5000);
      const hint = await ctx.eval(`document.querySelector('${HINT}').textContent`);
      ctx.equal(hint.match(/(\d+) parts/) && +hint.match(/(\d+) parts/)[1], expected.length, 'hint says "N parts" with N = the splitter result: ' + hint);
    } finally { await ctx.eval(`(() => { __ts6mod.anchors.chat.inputs()[0].msg = ${JSON.stringify(draft)}; document.dispatchEvent(new Event('input')); return 1; })()`); }
    await ctx.waitFor(`!document.querySelector('${HINT}')`, 'hint gone when the text is short again', 4000);
    ctx.skip('real typing and sending split messages', 'posts to the server: local test server only');
  } else {
  // 1. typing: the long text is accepted (not cut at the stock limit) and the hint shows the part count, live
  await type(text);
  await ctx.waitFor(`${MOD}.chatInput.text().length >= ${text.length - 5}`, 'the whole over-limit text is in the input (not cut at ' + stock + ')', 120000);
  await ctx.waitFor(`!!document.querySelector('${HINT}')`, 'hint appears', 20000);
  const hint = await ctx.eval(`document.querySelector('${HINT}').textContent`);
  ctx.equal(hint.match(/(\d+) parts/) && +hint.match(/(\d+) parts/)[1], expected.length, 'hint says "N parts" with N = the splitter result: ' + hint);

    // 2. send with a delay; the second client records what arrives
    let c2 = null;
    try { c2 = await connect(+(process.env.TS6MOD_CHAT_CDP2 || 9266)); } catch (e) { ctx.log('second client not reachable: only the sender side is verified'); }
    const rec = async (expr) => c2.eval(expr);
    if (c2) await rec(`(() => { const BRIDGE = window['tsclient' + '_internal']; /* second client is a plain client without the mod framework: the bridge is its only event source */ window.__chatRec = window.__chatRec || []; window.__chatRec.length = 0; if (!window.__chatRecOn) { window.__chatRecOn = true; BRIDGE.on('textMessage', m => window.__chatRec.push({ t: Date.now(), m: m.message })); } return 1; })()`);
    // sender side spy on the composer's submit call (the same path Enter / the send button use)
    await ctx.eval(`(() => { const vm = __ts6mod.anchors.chat.inputs()[0]; if (window.__chatSpyUndo) window.__chatSpyUndo(); window.__chatSpy = []; const had = Object.prototype.hasOwnProperty.call(vm.chat, 'SubmitMessage'), orig = vm.chat.SubmitMessage; window.__chatSpyUndo = () => { if (had) vm.chat.SubmitMessage = orig; else delete vm.chat.SubmitMessage; window.__chatSpyUndo = null; };
      vm.chat.SubmitMessage = function (t, ...r) { window.__chatSpy.push({ t: Date.now(), m: t }); return orig.call(this, t, ...r); }; return 1; })()`);
    const run = async (delay, body, parts, realTyping) => {
      await ctx.eval(`${MOD}.storage.set('delayMs', ${delay})`);
      if (c2) await rec(`window.__chatRec.length = 0`);
      await ctx.eval(`window.__chatSpy.length = 0`);
      if (realTyping === 'typed') { /* already typed (and hint-checked) above */ }
      else if (realTyping) { await type(body); await ctx.waitFor(`${MOD}.chatInput.text().length >= ${body.length - 5}`, 'text typed', 120000); }
      else { await ctx.eval(`${MOD}.chatInput.setText(${JSON.stringify(body)}); document.dispatchEvent(new Event('input'))`);  /* setText does not touch the editor: nudge the hint like a keystroke would */ await ctx.waitFor(`!!document.querySelector('${HINT}')`, 'hint for the set text', 5000); }
      await enter();
      await ctx.waitFor(`window.__chatSpy.length >= ${parts.length}`, `the composer submitted ${parts.length} messages`, 20000 + parts.length * delay);
      await ctx.sleep(300);
      const spy = await ctx.eval(`window.__chatSpy`);
      ctx.equal(spy.length, parts.length, `exactly ${parts.length} messages submitted (delay ${delay} ms)`);
      sameTexts(ctx, spy.map(s => s.m), parts.map(p => p.text), 'submitted messages = the splitter parts, in order');
      for (let i = 1; i < spy.length; i++) ctx.assert(spy[i].t - spy[i - 1].t >= delay - 30, `part ${i + 1} sent >= ${delay} ms after part ${i} (was ${spy[i].t - spy[i - 1].t} ms)`);
      if (c2) {
        await ctx.sleep(200);
        await (async () => { for (let i = 0; i < 40; i++) { if ((await rec(`window.__chatRec.length`)) >= parts.length) return; await ctx.sleep(250); } })();
        const got = await rec(`window.__chatRec`);
        sameTexts(ctx, got.map(g => g.m), parts.map(p => p.text), 'the second client received the parts in order, unchanged');
        for (let i = 1; i < got.length; i++) ctx.assert(got[i].t - got[i - 1].t >= delay - 60, `received part ${i + 1} >= ${delay} ms after part ${i} (was ${got[i].t - got[i - 1].t} ms)`);
        // rejoin: drop the added fences (prefix/suffix) -> the original text
        const bodies = got.map((g, i) => g.m.slice(parts[i].prefix.length, g.m.length - parts[i].suffix.length));
        ctx.equal(bodies.map((b, i) => b + parts[i].gap).join(''), body, 'rejoined (added fences removed) = the original text');
      }
      ctx.equal(await ctx.eval(`${MOD}.chatInput.text()`), '', 'the input is empty after sending');
      ctx.assert(await ctx.eval(`${MOD}.chatInput.element().textContent.length < 40`), 'the editor shows no leftover text');
      await ctx.waitFor(`!document.querySelector('${HINT}')`, 'hint gone after sending', 4000);
    };
    await run(300, text, expected, 'typed');
    const t2 = longText(40, 200, 6), p2 = splitParts(t2, { limit: budget, escLimit: ESC_LIMIT });
    ctx.assert(p2.length >= 3 && p2.some(p => p.prefix) && p2.some(p => p.suffix), 'second text: >= 3 parts, the code block is split (closed and reopened): ' + p2.length + ' parts');
    await run(150, t2, p2);
    const t3 = longText(30, 120, 1), p3 = splitParts(t3, { limit: budget, escLimit: ESC_LIMIT });
    await run(0, t3, p3);

    // the hint follows edits: a short text removes it
    await ctx.eval(`${MOD}.chatInput.setText(${JSON.stringify(text)}); document.dispatchEvent(new Event('input'))`); await ctx.waitFor(`!!document.querySelector('${HINT}')`, 'hint back for the long text', 5000);
    await ctx.eval(`${MOD}.chatInput.setText('short'); document.dispatchEvent(new Event('input'))`);
    await ctx.waitFor(`!document.querySelector('${HINT}')`, 'hint disappears for a short text', 4000);
    await ctx.eval(`${MOD}.chatInput.setText('')`);

    // a message that fits the server limit goes out untouched, as one message
    const fits = 'plain message ' + 'x'.repeat(2000);
    await ctx.eval(`window.__chatSpy.length = 0; ${MOD}.storage.set('delayMs', 0)`);
    await type(fits); await ctx.waitFor(`${MOD}.chatInput.text().length >= ${fits.length}`, 'typed', 4000);
    ctx.equal(await ctx.eval(`document.querySelectorAll('${HINT}').length`), 0, 'no hint for a message that fits');
    await enter(); await ctx.waitFor(`window.__chatSpy.length >= 1`, 'sent');
    await ctx.sleep(400);
    ctx.equal(await ctx.eval(`window.__chatSpy.map(s => s.m)`), [fits], 'a short message is one message, unchanged');
    await ctx.eval(`window.__chatSpyUndo(); delete window.__chatSpy; delete window.__chatSpyUndo`);
    if (c2) c2.close();
  }

  // 3. off: limit restored, hint and hook gone, nothing left behind
  await ctx.eval(`${MOD}.storage.remove('delayMs')`);
  if (local) await ctx.eval(`${MOD}.chatInput.setText('')`);
  await ctx.disable('chat');
  ctx.equal(await ctx.eval(`__ts6mod.anchors.chat.inputs()[0].maxInputLength`), stock, 'the original input limit is back after disable');
  ctx.equal(await ctx.eval(`document.querySelectorAll('[data-ts6mod="chat"]').length`), 0, 'hint and styles removed');
  await ctx.assertClean('chat');
  await ctx.restoreRoute();
}
