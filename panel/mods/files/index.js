/* Files mod: images over the upload limit are shrunk (max resolution, then the highest quality that fits, found by binary search)
 * in the page with the browser's own codecs before TeamSpeak sees them. Docs: superdoc/features/mod-files.md. */
ts6mod.register({
  id: 'files',
  title: 'Compress large images',
  description: 'Images over the upload limit are scaled down and re-encoded to fit automatically (chat drop/paste/attach, Files tab). Off = vanilla.',
  enable(api) {
    const DEF = { maxRes: 2560, format: 'jpeg', alpha: 'webp', margin: 5, limitMB: 5, chat: true, filesTab: true };
    const cfg = () => ({ ...DEF, ...(api.storage.all() || {}) });
    const CAP = { 'chat-drop': 5e6, 'chat-paste': 5242880 };          // the stock client's own limits for these two routes
    const effLimit = (route, c) => Math.min(c.limitMB * 1e6, CAP[route] ?? Infinity);
    const MIME = { jpeg: 'image/jpeg', webp: 'image/webp', png: 'image/png' };
    const EXT = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };
    const fmtMB = n => (n / 1e6).toFixed(n < 1e7 ? 2 : 1) + ' MB';
    const routeOn = (route, c) => (route.startsWith('chat') ? c.chat : c.filesTab);

    const isStillImage = async (meta, file) => {
      if (!/^image\/(png|jpeg|webp|bmp)$/.test(meta.type)) return false;           // gif, svg, avif, ... stay untouched
      if (!file) return true;
      const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
      const s = String.fromCharCode(...head);
      if (meta.type === 'image/png' && s.includes('acTL')) return false;          // animated PNG
      if (meta.type === 'image/webp' && s.includes('ANIM')) return false;         // animated WebP
      return true;
    };

    async function encode(canvas, type, q) { const b = await canvas.convertToBlob(type === 'image/png' ? { type } : { type, quality: q }); return b; }
    function draw(bmp, w, h, flatten) {
      const cv = new OffscreenCanvas(w, h), g = cv.getContext('2d');
      if (flatten) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); }
      g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, h); return cv;
    }
    function hasAlpha(cv) {
      const w = cv.width, h = cv.height, step = Math.max(1, Math.floor(Math.max(w, h) / 1024)), d = cv.getContext('2d').getImageData(0, 0, w, h).data;
      for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) if (d[(y * w + x) * 4 + 3] < 255) return true;
      return false;
    }

    /* convert(file, target bytes, config) -> {blob, w, h, type, quality}; scale down first, then quality by binary search,
       and if even the lowest quality does not fit, shrink the resolution by 15 % steps and search again. */
    async function compress(file, target, c) {
      const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
      try {
        let w = bmp.width, h = bmp.height; const k0 = Math.min(1, c.maxRes / Math.max(w, h));
        w = Math.max(1, Math.round(w * k0)); h = Math.max(1, Math.round(h * k0));
        let type = MIME[c.format] || 'image/jpeg', flatten = false;
        const probe = draw(bmp, w, h, false);
        if (file.type !== 'image/jpeg' && hasAlpha(probe)) {                        // transparency: keep it, or flatten onto white
          if (c.alpha === 'png') type = 'image/png';
          else if (c.alpha === 'webp') type = 'image/webp';
          else flatten = true;
        }
        const LO = 0.4, HI = 0.98;
        for (;;) {
          const cv = flatten ? draw(bmp, w, h, true) : (w === probe.width ? probe : draw(bmp, w, h, false));
          let best = null, q = null;
          if (type === 'image/png') { const b = await encode(cv, type); if (b.size <= target) best = { blob: b, quality: null }; }
          else {
            const top = await encode(cv, type, HI);
            if (top.size <= target) best = { blob: top, quality: HI };
            else {
              const low = await encode(cv, type, LO);
              if (low.size <= target) {
                best = { blob: low, quality: LO }; let lo = LO, hi = HI;
                for (let i = 0; i < 7; i++) { const m = (lo + hi) / 2, b = await encode(cv, type, m); if (b.size <= target) { best = { blob: b, quality: m }; lo = m; } else hi = m; }
              }
            }
          }
          if (best) return { ...best, w, h, type };
          if (Math.max(w, h) < 200) throw new Error('cannot reach the target size');
          w = Math.max(1, Math.round(w * 0.85)); h = Math.max(1, Math.round(h * 0.85));
        }
      } finally { bmp.close(); }
    }

    const outName = (name, type) => name.replace(/\.[^.]*$/, '') + '.' + EXT[type];
    const busy = new Set();
    async function process(file, route) {
      const c = cfg(), target = Math.floor(effLimit(route, c) * (1 - c.margin / 100));
      if (!(await isStillImage({ type: file.type }, file))) return null;
      const t0 = performance.now(), id = file.name + file.size; busy.add(id);
      try {
        const r = await compress(file, target, c), name = outName(file.name, r.type);
        const out = new File([r.blob], name, { type: r.type });
        const info = { name: file.name, from: { bytes: file.size, type: file.type }, to: { name, bytes: out.size, w: r.w, h: r.h, type: r.type, quality: r.quality }, route, ms: Math.round(performance.now() - t0) };
        (window.__ts6modFilesLog = window.__ts6modFilesLog || []).push(info);
        api.toast('Image compressed', `${file.name}: ${fmtMB(file.size)} -> ${fmtMB(out.size)} (${r.w}x${r.h}, ${r.type.split('/')[1]}${r.quality ? ' q' + Math.round(r.quality * 100) : ''})`);
        return out;
      } catch (e) {
        api.toast('Image not compressed', `${file.name}: ${e.message || e}`); return null;
      } finally { busy.delete(id); }
    }

    api.files.hook({
      wants: (meta, route) => { const c = cfg(); return routeOn(route, c) && /^image\/(png|jpeg|webp|bmp)$/.test(meta.type) && meta.size > effLimit(route, c); },
      process,
      vanillaLimit: route => CAP[route] ?? Infinity,
      notify: (text) => api.toast('Files', text),
    });
  },

  settings(api, box) {
    const { ui } = api, DEF = { maxRes: 2560, format: 'jpeg', alpha: 'webp', margin: 5, limitMB: 5, chat: true, filesTab: true };
    const get = k => { const v = api.storage.get(k, undefined); return v === undefined ? DEF[k] : v; };
    const set = (k, v) => api.storage.set(k, v);
    const group = (label, opts, key) => {
      const pills = opts.map(([v, text]) => ({ v, p: ui.pill({ label: text, onClick: () => { set(key, v); sync(); } }) }));
      const sync = () => pills.forEach(x => x.p.set(get(key) === x.v)); sync();
      return ui.row2(api.el('span', { class: 'mods-label' }, label), ...pills.map(x => x.p.el));
    };
    const sl = (key, label, min, max, step, unit, help) => { const s = ui.slider({ label, min, max, step, unit, value: get(key), help, onInput: v => set(key, v) }); s.set(get(key)); return s.el; };
    const tg = (key, title, sub) => { const t = ui.toggle({ title, sub, onChange: v => set(key, v) }); t.set(get(key)); return t.el; };
    const status = api.el('p', { class: 'mods-note' });
    const upd = () => { const r = api.files.routes(); status.textContent = 'Reachable now: ' + [r.chat ? 'chat attachments' : 'no chat with attachments open (TS3 server chats have none)', r.filesTab ? 'Files tab' : 'no Files tab open', r.reader ? 'path reader ok' : 'path reader missing (start with launcher/ts6-mod)'].join(', ') + '.'; };
    upd(); api.interval(upd, 1500);
    box.append(
      tg('chat', 'Chat attachments', 'Drag and drop, paste and the attach button of chats that allow attachments.'),
      tg('filesTab', 'Files tab', 'Channel and client Files tab: drag and drop, and the upload button.'),
      sl('limitMB', 'Compress images larger than', 1, 50, 1, ' MB', 'Chat drop and paste are capped by the client at 5 MB whatever this says.'),
      sl('maxRes', 'Maximum resolution (long edge)', 640, 8192, 64, ' px', 'Larger images are scaled down first.'),
      sl('margin', 'Target size margin', 0, 20, 1, ' %', 'The result is aimed this far below the limit.'),
      group('Output format', [['jpeg', 'JPEG'], ['webp', 'WebP']], 'format'),
      group('Transparent images', [['webp', 'WebP (keeps transparency)'], ['png', 'PNG (lossless, shrinks pixels)'], ['flatten', 'White background']], 'alpha'),
      ui.note('Re-encoding always drops metadata (EXIF, GPS, color profile); the rotation is applied to the pixels first. Animated GIF/PNG/WebP, other formats and files under the limit are not touched.'),
      status);
  },
});
