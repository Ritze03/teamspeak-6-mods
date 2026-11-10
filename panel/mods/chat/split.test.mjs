// Unit tests of the pure splitter in index.js. Run: node panel/mods/chat/split.test.mjs  (exit code 1 on failure)
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { splitMessage, splitParts, byteLength, escapedLength } = createRequire(import.meta.url)('./index.js');

let n = 0;
const test = (name, fn) => { try { fn(); n++; } catch (e) { console.error('FAIL', name, '\n', e.stack || e); process.exitCode = 1; } };

const FENCE_LINE = /^( {0,3})(`{3,}|~{3,})(.*)$/, CLOSE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
// fences balanced: scanning the text line by line, a fence that opens is closed again before the text ends
function balanced(t) {
  let st = null;
  for (const ln of t.split(/\r?\n/)) {
    let m;
    if (!st && (m = FENCE_LINE.exec(ln)) && !(m[2][0] === '`' && m[3].includes('`'))) st = { ch: m[2][0], len: m[2].length };
    else if (st && (m = CLOSE_LINE.exec(ln)) && m[1][0] === st.ch && m[1].length >= st.len) st = null;
  }
  return st === null;
}
// a fence-looking line longer than limit/4 bytes is deliberately treated as plain text by the splitter (documented limit)
const hugeFenceLine = (t, limit) => t.split(/\r?\n/).some(l => /^ {0,3}(`{3,}|~{3,})/.test(l) && byteLength(l) * 4 > limit);
// the generic property check used by every case: every part within the limit, fences balanced (when the input is),
// exact rejoin through body+gap, parts' text = prefix + body + suffix, no empty parts
function check(text, limit, label, escLimit) {
  const parts = splitParts(text, { limit, escLimit });
  for (const [i, p] of parts.entries()) {
    if (escLimit) assert.ok(escapedLength(p.text) <= escLimit, `${label}: part ${i} escaped size ${escapedLength(p.text)} > ${escLimit}`);
    assert.ok(byteLength(p.text) <= limit, `${label}: part ${i} has ${byteLength(p.text)} > ${limit} bytes`);
    assert.equal(p.text, p.prefix + p.body + p.suffix, `${label}: part ${i} text = prefix+body+suffix`);
    assert.ok(p.body.length > 0 && p.text.trim().length > 0, `${label}: part ${i} is empty`);
    if (balanced(text) && !hugeFenceLine(text, limit)) assert.ok(balanced(p.text), `${label}: part ${i} has unbalanced fences:\n${p.text}`);
    assert.ok(!/[\ud800-\udbff]$/.test(p.body) && !/^[\udc00-\udfff]/.test(p.body), `${label}: part ${i} splits a surrogate pair`);
  }
  assert.equal(parts.map(p => p.body + p.gap).join(''), text, `${label}: parts do not rejoin to the original`);
  assert.deepEqual(splitMessage(text, { limit, escLimit }), parts.map(p => p.text));
  return parts;
}

test('byteLength counts UTF-8 bytes', () => {
  assert.equal(byteLength('abc'), 3); assert.equal(byteLength('é'), 2); assert.equal(byteLength('漢'), 3);
  assert.equal(byteLength('😀'), 4); assert.equal(byteLength('\ud800'), 3);
  assert.equal(byteLength('é'.repeat(4096)), 8192); assert.equal(byteLength('😀'.repeat(2048)), 8192);
});

test('short text is returned untouched', () => {
  assert.deepEqual(splitMessage('hello', { limit: 100 }), ['hello']);
  assert.deepEqual(splitMessage('  keep   spaces \n', { limit: 100 }), ['  keep   spaces \n']);
  assert.deepEqual(splitMessage('', { limit: 100 }), ['']);
  const exact = 'a'.repeat(100); assert.deepEqual(splitMessage(exact, { limit: 100 }), [exact]);
  assert.equal(splitMessage('a'.repeat(101), { limit: 100 }).length, 2);
});

test('escaped size (space/newline/slash/pipe/backslash count 2) is limited too', () => {
  assert.equal(escapedLength('a b\nc/d|e\\f'), byteLength('a b\nc/d|e\\f') + 5);
  // 7 raw bytes per 4 escaped-heavy units: raw fits 8192 easily, escaped does not fit 9000
  const text = 'ab '.repeat(2700);   // 8100 raw, 10800 escaped chars
  assert.equal(splitMessage(text, { limit: 8160 }).length, 1);
  const parts = check(text, 8160, 'escaped', 9000);
  assert.ok(parts.length >= 2);
  for (const t of [text, ('line one\n' + '```js\nconsole.log("a b c");\n```\n').repeat(300), ' x'.repeat(5000)]) check(t, 8160, 'escaped-mixed', 9000);
  assert.deepEqual(splitMessage('a b', { limit: 100, escLimit: 3 }).join('|').length > 0, true);
});

test('limit below 16 bytes is refused', () => { assert.throws(() => splitMessage('x'.repeat(50), { limit: 8 }), RangeError); });

test('paragraph boundaries are preferred over lines and words', () => {
  const p1 = 'Alpha bravo charlie delta echo foxtrot golf hotel india juliet.', p2 = 'Kilo lima mike november oscar papa quebec romeo sierra tango.';
  const parts = check(p1 + '\n\n' + p2, 80, 'paragraph');
  assert.deepEqual(parts.map(p => p.text), [p1, p2]);
  assert.equal(parts[0].gap, '\n\n');
});

test('line boundaries are preferred over words', () => {
  const l = ['one two three four five six seven', 'eight nine ten eleven twelve thirteen', 'fourteen fifteen sixteen'];
  const parts = check(l.join('\n'), 70, 'lines');
  assert.deepEqual(parts.map(p => p.text), [l[0] + '\n' + l[1], l[2]].length === 2 && byteLength(l[0] + '\n' + l[1]) <= 70 ? [l[0] + '\n' + l[1], l[2]] : [l[0], l[1] + '\n' + l[2]]);
  for (const p of parts) assert.ok(!/\s$/.test(p.text) && !/^\s/.test(p.text), 'no dangling whitespace on a part');
});

test('words are split at spaces, never inside a word, when the line is long', () => {
  const words = Array.from({ length: 200 }, (_, i) => 'word' + i), text = words.join(' ');
  const parts = check(text, 120, 'words');
  const seen = parts.flatMap(p => p.text.split(' '));
  assert.deepEqual(seen, words);
});

test('a single giant word is hard-split on the byte limit', () => {
  const parts = check('x'.repeat(1000), 100, 'giant');
  assert.equal(parts.length, 10); assert.ok(parts.every(p => p.text.length === 100));
  const withText = check('hello ' + 'y'.repeat(500) + ' bye', 100, 'giant+words');
  assert.equal(withText[0].text, 'hello');   // the word before it goes first, only the over-long word is cut
});

test('unicode: emoji / CJK / combining / CRLF are never cut in the middle', () => {
  for (const [name, ch] of [['emoji', '😀'], ['cjk', '漢'], ['latin', 'é'], ['zwj', '👩‍👩‍👧'], ['combining', 'é'], ['flag', '🇩🇪']]) {
    const parts = check(ch.repeat(900), 97, name);
    for (const p of parts) assert.ok(p.body.length > 0);
    assert.equal(parts.map(p => p.body).join(''), ch.repeat(900));
  }
  const zwj = '👩‍👩‍👧'.repeat(300);
  for (const p of check(zwj, 101, 'zwj-clusters')) assert.ok(!p.body.startsWith('‍') && !p.body.endsWith('‍'), 'no cut next to a ZWJ');
  check(('日本語のテキスト ' + '😀 ').repeat(200), 150, 'mixed');
  check(('line one\r\nline two\r\n\r\npara ').repeat(60), 120, 'crlf');
  check('a\ud800b'.repeat(200), 50, 'lone surrogate');
});

test('measured server limit: 8192 UTF-8 bytes, margin respected', () => {
  const text = ('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ').repeat(400);
  for (const limit of [8192, 8160, 4096, 500]) check(text, limit, 'limit ' + limit);
  check('é'.repeat(9000), 8160, 'bytes not chars'); check('😀'.repeat(5000), 8160, 'emoji bytes');
});

test('a code block that fits stays whole and is not split from its surroundings badly', () => {
  const code = '```js\nconst a = 1;\nconst b = 2;\n```';
  const parts = check('Intro text that is long enough. '.repeat(3) + '\n\n' + code + '\n\nOutro.', 120, 'whole block');
  const holder = parts.find(p => p.text.includes('const a'));
  assert.ok(holder.text.includes('```js') && holder.text.includes('const b = 2;\n```'), 'block is in one part');
});

test('only a code block, split in the middle: closed and reopened with the same fence and language', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `console.log("line ${i}");`);
  const text = '```js\n' + lines.join('\n') + '\n```';
  const parts = check(text, 300, 'only code');
  assert.ok(parts.length > 2);
  for (const [i, p] of parts.entries()) {
    assert.ok(p.text.startsWith('```js\n'), `part ${i} starts with the fence + language`);
    assert.ok(p.text.endsWith('\n```'), `part ${i} ends with the closing fence`);
    assert.equal(p.text.split('\n').filter(l => l === '```').length, 1);
  }
  // rejoined without added fences: exactly the original code lines
  assert.equal(parts.map(p => p.body + p.gap).join(''), text);
  assert.equal(parts.slice(1).every(p => p.prefix === '```js\n'), true);
  assert.equal(parts[0].prefix, '');
});

test('~~~ fences and longer fences keep their own character and length', () => {
  const body = Array.from({ length: 60 }, (_, i) => `row ${i}: some content here`).join('\n');
  for (const fence of ['~~~', '~~~~~', '````', '```', '~~~ python title=x']) {
    const f = fence.split(' ')[0], text = 'Before.\n\n' + fence + '\n' + body + '\n' + f + '\n\nAfter.';
    const parts = check(text, 260, 'fence ' + fence);
    for (const p of parts) if (p.suffix) assert.equal(p.suffix, '\n' + f, 'closes with the same fence');
    for (const p of parts.slice(1)) if (p.prefix) assert.ok(p.prefix.startsWith(f), 'reopens with the same fence');
  }
});

test('nested-looking fences: shorter / other-char fences inside a block are content', () => {
  const inner = ['```md', '~~~', 'inner text', '~~~', '```'];
  const text = '````\n' + Array.from({ length: 20 }, () => inner.join('\n')).join('\n') + '\n````';
  const parts = check(text, 200, 'nested');
  for (const p of parts) { assert.ok(p.text.startsWith('````\n')); assert.ok(p.text.endsWith('\n````')); }
  const tilde = '~~~\n' + 'a ``` b\n'.repeat(80) + '~~~';
  check(tilde, 150, 'backticks inside tilde fence');
});

test('language tag / info string with attributes is reopened verbatim', () => {
  const text = '```rust {highlight=1,3}\n' + 'fn main() { println!("x"); }\n'.repeat(60) + '```';
  const parts = check(text, 250, 'info');
  for (const p of parts.slice(1)) assert.ok(p.text.startsWith('```rust {highlight=1,3}\n'));
});

test('indented fences (up to 3 spaces) are recognised', () => {
  const text = 'list item:\n\n   ```sh\n' + '   echo hello world\n'.repeat(60) + '   ```\n\nend';
  check(text, 200, 'indented');
});

test('text between several blocks: each block balanced in every part', () => {
  let text = '';
  for (let i = 0; i < 12; i++) text += `Paragraph ${i} with some words.\n\n\`\`\`py\n${'x = 1\n'.repeat(15 + i)}\`\`\`\n\n`;
  check(text.trimEnd(), 400, 'many blocks'); check(text.trimEnd(), 150, 'many blocks small');
});

test('no empty block: never cut right after the opening fence or right before the closing fence', () => {
  for (const limit of [60, 61, 62, 63, 64, 65, 66, 70, 75, 80]) {
    const text = 'x'.repeat(limit - 30) + '\n```\n' + 'code line one\ncode line two\ncode three\n```\ntail';
    for (const p of check(text, limit, 'degenerate ' + limit)) assert.ok(!/```[a-z]*\n```/.test(p.text), 'empty code block in:\n' + p.text);
  }
});

test('trailing whitespace and blank lines at the cut do not end up in the parts', () => {
  const text = ('word  \t \n\n\n   ').repeat(100) + 'end';
  const parts = check(text, 90, 'whitespace');
  for (const p of parts) assert.ok(p.text === p.text.trim(), 'part is trimmed: ' + JSON.stringify(p.text));
});

test('trailing newline / unclosed fence of the input is carried through', () => {
  const t1 = 'a line\n'.repeat(200); const p1 = check(t1, 100, 'trailing newline');
  assert.ok(p1.at(-1).body.endsWith('\n'));
  const t2 = '```js\n' + 'let x = 1;\n'.repeat(100);   // never closed
  const p2 = check(t2, 150, 'unclosed');
  for (const p of p2.slice(0, -1)) assert.ok(p.text.endsWith('\n```'));
});

test('an over-long fence line is plain text (cannot eat the budget)', () => {
  const text = '`'.repeat(200) + '\nabc def ghi\n' + '~'.repeat(400) + '\n' + 'tail words '.repeat(50);
  check(text, 100, 'long fence line');
});

test('randomised property check', () => {
  let seed = +(process.env.SEED || 12345); const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const atoms = ['word', 'a', 'longerword', '漢字', '😀', 'é', ' ', ' ', '  ', '\n', '\n', '\n\n', '\r\n', '\t', '```', '```js\n', '~~~\n', '````\n', '`inline`', '👩‍👩‍👧', 'é'];
  for (let k = 0; k < +(process.env.FUZZ || 400); k++) {
    let text = ''; const len = 20 + Math.floor(rnd() * 400);
    for (let i = 0; i < len; i++) text += pick(atoms);
    const limit = 40 + Math.floor(rnd() * 300);
    const esc = k % 2 ? 0 : Math.floor(limit * (1 + rnd()));
    try { check(text, limit, `random #${k} limit ${limit} esc ${esc}`, esc || undefined); }
    catch (e) { console.error('seed case', k, JSON.stringify(text), limit); throw e; }
  }
});

console.log(`split.test.mjs: ${n} tests ${process.exitCode ? 'WITH FAILURES' : 'passed'}`);
