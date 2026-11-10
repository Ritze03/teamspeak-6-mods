/* Core extension of the "files" mod (panel/mods/files/): every TeamSpeak name the mod needs, plus api.files.
 * Where images enter the client (all probed live, see superdoc/features/mod-files.md "Upload routes"):
 *   chat-drop    drop on a chat view   -> parent onDrop: rejects files > 5,000,000 B, then composer.onDraggedFileBlob(File, name)
 *   chat-paste   paste into composer   -> composer.on_paste: rejects files > 5,242,880 B, then pushes a data: URL preview
 *   chat-picker  attach button         -> composer.displayInlineFilePicker: native dialog, pushes a PATH preview (no size check)
 *   files-drop   channel/client Files tab drop      -> file model uploadFileByData(File, dir)
 *   files-picker Files tab upload button -> file model uploadFilesByPath(undefined, dir): native dialog, native path upload
 * The chat routes exist only where the composer has hasFileUploadAction (TS6 account chats); a plain TS3 server's chat has none.
 * api.files.hook({wants, process, vanillaLimit, notify}) intercepts them. Paths that the page cannot read (picker) are read through
 * the injector's narrow image reader (binding ts6modReadImage, tools/cdp/mods-inject.mjs). */
(function (boot) {
  'use strict';
  const A = boot.anchors, { $$ } = A;
  const PICKER_TITLE = 'Choose files to upload';

  /* ---------- anchors ---------- */
  const composers = () => $$('.ts-chat-input-container').map(e => e.__vue__).filter(v => v && typeof v.onDraggedFileBlob === 'function' && v.previewItems);
  const fileViews = () => $$('[class*="ts-info-files-"]').map(e => e.__vue__).filter(v => v && v.model && typeof v.model.uploadFileByData === 'function' && typeof v.model.uploadFilesByPath === 'function');
  A.def('files.composer', 'chat composer vm with previewItems, onDraggedFileBlob, displayInlineFilePicker (only while a chat is displayed)', () => { const v = composers()[0]; return v && typeof v.displayInlineFilePicker === 'function' && v; }, true);
  A.def('files.fileView', 'Files tab vm (.ts-info-files-*) whose model has uploadFileByData / uploadFilesByPath (only while a Files tab is displayed)', () => fileViews()[0], true);
  A.def('files.dialog', 'native file dialog bridge call (showFileDialog(kind, title, filter, mimeTypes, cb(status, paths)))', () => typeof window.tsclient_internal?.showFileDialog === 'function' && window.tsclient_internal.showFileDialog);

  /* ---------- reading a picker path: injector binding ts6modReadImage (images only, chunked) ---------- */
  const pending = new Map(); let seq = 0;
  const readReply = r => { const w = pending.get(r.id); if (w) { pending.delete(r.id); clearTimeout(w.t); r.ok ? w.res(r) : w.rej(new Error(r.error || 'read failed')); } };
  function readChunk(path, offset, length) {
    return new Promise((res, rej) => {
      if (typeof window.ts6modReadImage !== 'function') return rej(new Error('injector read binding missing'));
      window.__ts6modImgReply = readReply;
      const id = ++seq, t = setTimeout(() => { pending.delete(id); rej(new Error('read timeout')); }, 30000);
      pending.set(id, { res, rej, t });
      window.ts6modReadImage(JSON.stringify({ id, path, offset, length }));
    });
  }
  const readStat = path => readChunk(path, 0, 0).then(r => ({ name: r.name, size: r.size, type: r.mime }));
  async function readPathFile(path, meta) {
    const CH = 6 * 1024 * 1024, parts = [];
    for (let off = 0; off < meta.size; off += CH) {
      const r = await readChunk(path, off, CH), bin = atob(r.b64), u = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
      parts.push(u);
    }
    return new File(parts, meta.name, { type: meta.type });
  }

  function pickPaths() {
    const seam = window.__ts6modFilesTest;
    if (seam && Array.isArray(seam.dialogPaths)) return Promise.resolve(seam.dialogPaths.slice());
    return new Promise(res => A.get('files.dialog')(1, PICKER_TITLE, '', [], (st, paths) => res(Array.isArray(paths) ? paths : [])));
  }

  /* ---------- the hook engine ---------- */
  const hooks = new Set();   // active hook specs (normally one: the files mod)
  const metaOf = f => ({ name: f.name, size: f.size, type: f.type });
  const wantsAny = (files, route) => { for (const h of hooks) if (files.some(f => safe(() => h.wants(metaOf(f), route)))) return h; return null; };
  const safe = fn => { try { return fn(); } catch (e) { boot.core.warn('files hook', e); return false; } };
  const extOf = t => (t.split('/')[1] || 'png').replace('jpeg', 'jpg');

  // attach one file to the composer the way the stock drop does (preview chip, uploaded when the message is sent)
  const attach = (c, f, name) => c.onDraggedFileBlob(f, name || f.name);

  async function handleChatFiles(h, c, files, route) {
    const room = Math.max(0, 10 - c.previewItems.length);
    for (const f of files.slice(0, room)) {
      let out = f;
      if (h.wants(metaOf(f), route)) {
        try { out = (await h.process(f, route)) || f; } catch (e) { boot.core.warn('files process', e); out = f; }
      }
      const lim = h.vanillaLimit(route);
      if (out.size > lim) { h.notify(`"${f.name}" was not attached: ${(out.size / 1e6).toFixed(1)} MB is over the ${(lim / 1e6).toFixed(0)} MB limit (use the attach button for big files)`, 'warn'); continue; }
      attach(c, out, route === 'chat-paste' && /^image\.\w+$/.test(out.name) ? `image_${Date.now()}.${extOf(out.type)}` : out.name);
    }
    if (files.length > room) h.notify('Cannot attach more than 10 files to a message, additional files were ignored', 'warn');
  }

  const dropRegion = c => { let p = c; while (p && typeof p.onDrop !== 'function') p = p.$parent; return p; };
  const composerAt = (target, drop) => composers().find(c => c.hasFileUploadAction && (drop ? (dropRegion(c) || c).$el : c.$el).contains(target));

  function onDrop(e) {
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    const c = composerAt(e.target, true); if (!c) return;
    const h = wantsAny(files, 'chat-drop'); if (!h) return;
    e.preventDefault(); e.stopImmediatePropagation();
    // the stock drop handler is a v-dnd directive that counts dragenter/dragleave and resets itself on drop; we swallowed the drop, so
    // send one dragleave (its coordinates are 0/0, which makes the directive reset its counter) and hide the overlay ourselves
    const r = dropRegion(c); if (r) { for (const k of ['showFileDropzone', 'showDropzone']) if (k in r) r[k] = false; }
    const tgt = e.target, dt = e.dataTransfer;
    setTimeout(() => tgt.dispatchEvent(new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt })), 0);
    handleChatFiles(h, c, files, 'chat-drop');
  }
  function onPaste(e) {
    const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    const c = composerAt(e.target, false); if (!c) return;
    const h = wantsAny(files, 'chat-paste'); if (!h) return;
    e.preventDefault(); e.stopImmediatePropagation();
    handleChatFiles(h, c, files, 'chat-paste');
  }

  /* generic "patch an instance method, restore on undo" */
  const patched = new WeakMap();   // object -> Set(method names) currently patched by us
  function patchMethod(obj, name, make, undos) {
    const set = patched.get(obj) || new Set(); patched.set(obj, set);
    if (set.has(name)) return;
    const had = Object.prototype.hasOwnProperty.call(obj, name), orig = obj[name];
    obj[name] = make(orig.bind(obj));
    set.add(name);
    undos.push(() => { set.delete(name); if (had) obj[name] = orig; else delete obj[name]; });
  }

  async function filterPaths(h, paths, route) {   // -> {keep: [paths for the stock route], files: [compressed Files]}
    const keep = [], files = [];
    for (const p of paths) {
      let meta = null;
      try { meta = await readStat(p); } catch (e) { /* not an image / unreadable / no binding: stock route */ }
      if (meta && safe(() => h.wants(meta, route))) {
        try { const f = await h.process(await readPathFile(p, meta), route); if (f) { files.push(f); continue; } } catch (e) { boot.core.warn('files picker', e); }
      }
      keep.push(p);
    }
    return { keep, files };
  }

  function patchComposer(c, h, undos) {
    patchMethod(c, 'displayInlineFilePicker', orig => function () {
      if (!hooks.has(h)) return orig();
      c.emojiPickerHidden = true;
      pickPaths().then(async paths => {
        if (!paths.length) return;
        const room = Math.max(0, 10 - c.previewItems.length);
        const { keep, files } = await filterPaths(h, paths.slice(0, room), 'chat-picker');
        const done = (e, t) => { t > 0 && c.onFileUploadFailed(e); };
        for (const f of files) {   // compressed: a data: URL preview (the stock drop route uploads those too)
          const url = await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(f); });
          c.previewItems.unshift({ fileOrUri: url, progress: 0, state: 0, mxc: '', previewName: f.name, completion: done });
        }
        for (const p of keep) c.previewItems.unshift({ fileOrUri: p, progress: 0, state: 0, mxc: '', completion: done });
        c.focus && c.focus();
      });
    }, undos);
  }

  function patchModel(m, h, undos) {
    patchMethod(m, 'uploadFileByData', orig => (file, dest, cb) => {
      if (!hooks.has(h) || !(file instanceof File) || !h.wants(metaOf(file), 'files-drop')) return orig(file, dest, cb);
      return h.process(file, 'files-drop').catch(() => null).then(out => orig(out || file, dest, cb));
    }, undos);
    patchMethod(m, 'uploadFilesByPath', orig => (paths, dest, cb) => {
      if (paths !== undefined || !hooks.has(h)) return orig(paths, dest, cb);   // retries pass explicit paths: stock
      return pickPaths().then(async picked => {
        if (!picked.length) return [];
        const { keep, files } = await filterPaths(h, picked, 'files-picker');
        const out = keep.length ? await orig(keep, dest, cb) : [];
        return [...out, ...files.map(f => m.uploadFileByData(f, dest, cb))];
      });
    }, undos);
  }

  /* ---------- api.files ---------- */
  boot.core.coreApi('files', (api, track) => ({
    available: () => typeof window.ts6modReadImage === 'function',
    /* hook({wants(meta, route) -> bool, process(File, route) -> Promise<File|null>, vanillaLimit(route) -> bytes, notify(text, kind)})
       routes: 'chat-drop' | 'chat-paste' | 'chat-picker' | 'files-drop' | 'files-picker'; everything is undone on disable. */
    hook(spec) {
      const h = { wants: spec.wants, process: spec.process, vanillaLimit: spec.vanillaLimit || (() => Infinity), notify: spec.notify || (() => {}) };
      hooks.add(h);
      document.addEventListener('drop', onDrop, true); document.addEventListener('paste', onPaste, true);
      const undos = [];
      const scan = () => { composers().forEach(c => patchComposer(c, h, undos)); fileViews().forEach(v => patchModel(v.model, h, undos)); };
      scan();
      const offDom = api.onDom(scan, { debounce: 300 });
      return track('files-hook', () => {
        hooks.delete(h); offDom && offDom();
        if (!hooks.size) { document.removeEventListener('drop', onDrop, true); document.removeEventListener('paste', onPaste, true); }
        undos.splice(0).reverse().forEach(u => u());
      });
    },
    /* status for the settings page: which routes are reachable right now */
    routes: () => ({ chat: composers().some(c => c.hasFileUploadAction), filesTab: fileViews().length > 0, reader: typeof window.ts6modReadImage === 'function' }),
  }));

  /* ---------- test seam (used by panel/mods/files/test.mjs; lint forbids TS names there) ---------- */
  const readData = async url => {
    const b = await (await fetch(url)).blob(), o = { bytes: b.size, mime: b.type };
    if (!/^image\//.test(b.type)) return o;
    let bmp; try { bmp = await createImageBitmap(b); } catch (e) { return o; }
    o.w = bmp.width; o.h = bmp.height;
    const cv = new OffscreenCanvas(bmp.width, bmp.height), g = cv.getContext('2d'); g.drawImage(bmp, 0, 0); bmp.close();
    const d = g.getImageData(0, 0, o.w, o.h).data; o.alpha = false;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] < 250) { o.alpha = true; break; }
    return o;
  };
  window.__ts6modFilesTest = {
    dialogPaths: null,
    forceChat() { const c = composers()[0]; if (!c) return false; this._was = [c._props.hasFileUploadAction, dropRegion(c)?._props.disableFiletransfer]; this._set(c, true); return true; },
    unforceChat() { const c = composers()[0]; if (c && this._was) this._set(c, this._was[0], this._was[1]); },
    _set(c, on, was) { c._props.hasFileUploadAction = on; const r = dropRegion(c); if (r && r._props && 'disableFiletransfer' in r._props) r._props.disableFiletransfer = was !== undefined ? was : !on; },
    chatAvailable: () => composers().length > 0,
    async previews() { const c = composers()[0]; const out = []; for (const p of c ? c.previewItems : []) { const isData = typeof p.fileOrUri === 'string' && p.fileOrUri.startsWith('data:'); out.push({ name: p.previewName || null, path: isData ? null : p.fileOrUri, ...(isData ? await readData(p.fileOrUri) : {}) }); } return out; },
    clearPreviews() { const c = composers()[0]; if (c) c.previewItems.splice(0); },
    async makeFile(spec) {   // {noise:{w,h,alpha,type}} | {zip:bytes} | {path}
      if (spec.path) { const meta = await readStat(spec.path); return readPathFile(spec.path, meta); }
      if (spec.zip) { const u = new Uint8Array(spec.zip); for (let o = 0; o < u.length; o += 65536) crypto.getRandomValues(u.subarray(o, Math.min(u.length, o + 65536))); u[0] = 0x50; u[1] = 0x4b; return new File([u], spec.name || 'x.zip', { type: 'application/zip' }); }
      const { w, h, alpha, type = 'image/png' } = spec.noise, cv = new OffscreenCanvas(w, h), g = cv.getContext('2d'), id = g.createImageData(w, h);
      for (let o = 0; o < id.data.length; o += 65536) crypto.getRandomValues(id.data.subarray(o, Math.min(id.data.length, o + 65536)));
      for (let i = 3; i < id.data.length; i += 4) id.data[i] = alpha ? (i >> 2) % 7 === 0 ? 0 : 255 : 255;
      g.putImageData(id, 0, 0);
      const blob = await cv.convertToBlob({ type, quality: 1 });
      return new File([blob], spec.name || 'noise.' + extOf(type), { type });
    },
    dropOnChat(files) {
      const c = composers()[0]; if (!c) return false;
      const dt = new DataTransfer(); files.forEach(f => dt.items.add(f));
      c.$el.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
      c.$el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true;
    },
    pasteOnChat(files) {
      const c = composers()[0]; if (!c) return false;
      const dt = new DataTransfer(); files.forEach(f => dt.items.add(f));
      c.$el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); return true;
    },
    pickInChat() { const c = composers()[0]; if (!c) return false; c.displayInlineFilePicker(); return true; },
    /* a stand-in for a Files tab model, so the model patch can be tested without displaying a Files tab */
    fake: null,
    installFakeModel() {
      const calls = [];
      const m = { calls, uploadFileByData: (f, d) => { calls.push({ kind: 'data', name: f.name, size: f.size, type: f.type, dest: d }); return Promise.resolve(); },
        uploadFilesByPath: (p, d) => { calls.push({ kind: 'paths', paths: p, dest: d }); return Promise.resolve((p || []).map(() => Promise.resolve())); } };
      const el = document.createElement('div'); el.className = 'ts-info-files-fake'; el.style.display = 'none'; el.__vue__ = { model: m }; el.setAttribute('data-ts6mod-test', '1');
      document.body.append(el); this.fake = { m, el }; return true;
    },
    removeFakeModel() { if (this.fake) { this.fake.el.remove(); this.fake = null; } },
    fakeUpload(file) { return this.fake.m.uploadFileByData(file, '/'); },
    fakePick() { return this.fake.m.uploadFilesByPath(undefined, '/'); },
    fakeCalls() { return this.fake ? this.fake.m.calls : []; },
  };
})(window.__ts6modBoot);
