/* Net mod: connection quality HUD in the server pane's bottom bar next to the client's own connection status, or in the top bar (ping, packet loss, optional bandwidth), a popover with a 60 s sparkline,
 * stats, the channel codec and a "Copy diagnostics" button, optional threshold alerts. Data comes from api.net (panel/core/x-net.js).
 * Polls only while the mod is on AND a connection is established. Docs: superdoc/features/mod-net.md. */
(() => {
  const DEFAULTS = { interval: 2, alert: false, pingMax: 150, lossMax: 5, bandwidth: true, position: 'bottom' };
  const HISTORY_MS = 60000, ALERT_COOLDOWN_MS = 60000, ALERT_SAMPLES = 2, RECOVER = 0.8;
  const SVG = 'http://www.w3.org/2000/svg';
  let live = null;   // the running instance (settings changes are applied through it)

  const fmtMs = v => (v == null ? '-' : Math.round(v) + ' ms');
  const fmtPct = v => (v == null ? '-' : (v < 10 ? v.toFixed(1) : Math.round(v)) + ' %');
  const fmtBwShort = v => (v == null ? '-' : v >= 1048576 ? (v / 1048576).toFixed(1) + 'M' : v >= 1024 ? (v / 1024).toFixed(1) + 'k' : Math.round(v) + 'B');
  const fmtBw = v => (v == null ? '-' : v >= 1048576 ? (v / 1048576).toFixed(1) + ' MB/s' : v >= 1024 ? (v / 1024).toFixed(1) + ' kB/s' : Math.round(v) + ' B/s');
  const stat = vals => { const v = vals.filter(x => x != null); return v.length ? { min: Math.min(...v), max: Math.max(...v), avg: v.reduce((a, b) => a + b, 0) / v.length } : null; };

  function osName() {
    try { return (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'unknown'; } catch (e) { return 'unknown'; }
  }

  function glyph() {   // three signal bars, drawn with the text colour
    const g = document.createElementNS(SVG, 'svg'); g.setAttribute('viewBox', '0 0 12 12'); g.setAttribute('class', 'net-glyph');
    [[1, 7, 2.5, 4], [4.7, 4, 2.5, 7], [8.5, 1, 2.5, 10]].forEach(([x, y, w, h]) => { const r = document.createElementNS(SVG, 'rect'); r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', w); r.setAttribute('height', h); r.setAttribute('rx', 0.8); g.append(r); });
    return g;
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back below */ }
    const ta = document.createElement('textarea'); ta.value = text; ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove(); return ok;
  }

  ts6mod.register({
    id: 'net',
    title: 'Connection quality',
    group: 'Server & network', order: 1,
    icon: 'M5 19v-3 M10 19v-7 M15 19V8 M20 19V4',
    summary: 'Ping and packet loss next to the connection status at the bottom of the channel tree. Click the readout for a graph and details.',
    keywords: ['Update interval', 'Show bandwidth', 'Position', 'Bottom bar', 'Top bar', 'Alerts', 'Ping limit', 'Loss limit', 'Copy diagnostics', 'HUD'],
    status: api => { const s = Object.assign({}, DEFAULTS, api.storage.all()); return 'every ' + s.interval + ' s' + (s.position === 'top' ? ' · top bar' : '') + (s.alert ? ' · alerts' : ''); },
    description: 'Ping and packet loss in the bottom bar of the channel tree (or the top bar), with a 60 s history graph, codec readout, optional alerts and a copy-diagnostics button.',
    enable(api) {
      const S = () => Object.assign({}, DEFAULTS, api.storage.all());
      let samples = [], busy = false, stopTick = null, updates = 0, popOpen = false, lastMeta = null;
      const alarm = { ping: { n: 0, on: false, at: 0 }, loss: { n: 0, on: false, at: 0 } };

      /* ---- HUD ---- */
      const elPing = api.el('span', { class: 'net-v net-ping' }, '- ms'), elLoss = api.el('span', { class: 'net-v net-loss' }, '- %'), elBw = api.el('span', { class: 'net-v net-bw' });
      const hud = api.el('div', { class: 'net-hud', role: 'button', tabindex: '0', title: 'Connection quality (click for details); data rate is per second', hidden: true, on: {
        click: () => togglePop(),
        keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); togglePop(); } },
      } }, glyph(), elPing, elLoss, elBw);
      hud.setAttribute('data-net', 'hud');
      /* placement: bottom bar (first item of the stock connection-status group) or top bar; switched live from the settings */
      let unplace = null, placedAt = null;
      function place() {
        const at = S().position === 'top' ? 'top' : 'bottom';
        if (at === placedAt) return;
        if (unplace) unplace();
        placedAt = at; hud.classList.toggle('net-bottom', at === 'bottom');
        if (at === 'top') { const h = api.topBar.add(hud); unplace = () => h.remove(); } else unplace = api.net.bottomBar.mount(hud);
        if (popOpen) placePop();
      }

      /* ---- popover (a body-level node so a clipping toolbar cannot cut it; removed in disable()) ---- */
      const th = api.net.theme();
      const pop = api.el('div', { class: 'net-pop', hidden: true, style: `--net-pop-bg:${th.bg};--net-pop-line:${th.line}` });
      pop.setAttribute('data-net', 'pop');
      document.body.append(pop);
      const svg = document.createElementNS(SVG, 'svg'); svg.setAttribute('class', 'net-graph'); svg.setAttribute('viewBox', '0 0 240 64'); svg.setAttribute('preserveAspectRatio', 'none');
      const rows = api.el('div', { class: 'net-rows' });
      const copyBtn = api.ui.button({ label: 'Copy diagnostics', onClick: () => doCopy() });
      const settingsBtn = api.ui.button({ label: 'Settings', kind: 'link', onClick: () => { closePop(); api.settings.show(); } });
      pop.append(api.el('div', { class: 'net-pop-title' }, 'Connection quality'), svg, rows, api.el('div', { class: 'net-actions' }, copyBtn, settingsBtn));

      function placePop() {
        const r = hud.getBoundingClientRect(), w = pop.offsetWidth || 280;
        const below = r.bottom + 6, ph = pop.offsetHeight || 260;   // under the HUD, or above it when it sits at the bottom of the window
        pop.style.top = Math.round(below + ph > window.innerHeight - 8 ? Math.max(8, r.top - 6 - ph) : below) + 'px';
        pop.style.left = Math.round(Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))) + 'px';
      }
      function openPop() { popOpen = true; pop.hidden = false; renderPop(); placePop(); refreshMeta(); }
      function closePop() { popOpen = false; pop.hidden = true; }
      function togglePop() { popOpen ? closePop() : openPop(); }
      api.listen(document, 'mousedown', e => { if (popOpen && !pop.contains(e.target) && !hud.contains(e.target)) closePop(); }, true);
      api.listen(document, 'keydown', e => { if (popOpen && e.key === 'Escape') closePop(); }, true);
      api.listen(window, 'resize', () => { if (popOpen) placePop(); });

      function refreshMeta() { lastMeta = api.net.meta(); if (popOpen) renderPop(); }

      /* ---- rendering ---- */
      function renderHud() {
        const s = S(), last = samples[samples.length - 1];
        hud.hidden = !api.net.connected();
        if (hud.hidden) { if (popOpen) closePop(); return; }
        elPing.textContent = last ? fmtMs(last.ping) : '- ms';
        elLoss.textContent = last ? fmtPct(last.loss) : '- %';
        elPing.classList.toggle('warn', !!(last && last.ping != null && last.ping > s.pingMax));
        elLoss.classList.toggle('bad', !!(last && last.loss != null && last.loss > s.lossMax));
        elBw.hidden = !s.bandwidth;
        elBw.textContent = last && s.bandwidth ? `↓${fmtBwShort(last.bwIn)} ↑${fmtBwShort(last.bwOut)}` : '';
        hud.setAttribute('data-updates', String(updates));
      }
      function line(label, value) { return api.el('div', { class: 'net-row' }, api.el('span', { class: 'net-k' }, label), api.el('span', { class: 'net-val' }, value)); }
      function drawGraph(s) {
        svg.replaceChildren();
        const W = 240, H = 64, t1 = Date.now(), t0 = t1 - HISTORY_MS, X = t => ((t - t0) / HISTORY_MS) * W, Y = (v, max) => H - 3 - (v / max) * (H - 6);
        const pings = samples.map(x => x.ping).filter(v => v != null), losses = samples.map(x => x.loss).filter(v => v != null);
        const pMax = Math.max(s.pingMax * 1.2, ...pings, 20), lMax = Math.max(s.lossMax * 1.5, ...losses, 1);
        const mk = (tag, attrs) => { const n = document.createElementNS(SVG, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); svg.append(n); return n; };
        mk('line', { x1: 0, x2: W, y1: Y(s.pingMax, pMax), y2: Y(s.pingMax, pMax), class: 'net-thr' });
        const bw = Math.max(1.5, (W / HISTORY_MS) * s.interval * 1000 * 0.8);
        for (const x of samples) if (x.loss) mk('rect', { x: X(x.t) - bw, y: H - (x.loss / lMax) * H, width: bw, height: (x.loss / lMax) * H, class: 'net-loss-bar' });
        const pts = samples.filter(x => x.ping != null).map(x => `${X(x.t).toFixed(1)},${Y(x.ping, pMax).toFixed(1)}`);
        if (pts.length > 1) mk('polyline', { points: pts.join(' '), class: 'net-ping-line' });
        else if (pts.length === 1) { const [cx, cy] = pts[0].split(','); mk('circle', { cx, cy, r: 1.8, class: 'net-ping-dot' }); }
      }
      function renderPop() {
        const s = S(), last = samples[samples.length - 1], ps = stat(samples.map(x => x.ping)), ls = stat(samples.map(x => x.loss));
        drawGraph(s);
        rows.replaceChildren(
          line('Ping', last ? `${fmtMs(last.ping)}${last.jitter != null ? ` (jitter ${last.jitter.toFixed(1)} ms)` : ''}` : '-'),
          line('Ping min / avg / max', ps ? `${fmtMs(ps.min)} / ${fmtMs(ps.avg)} / ${fmtMs(ps.max)}` : '-'),
          line('Packet loss', last ? `${fmtPct(last.loss)} (up ${fmtPct(last.lossUp)}, down ${fmtPct(last.lossDown)})` : '-'),
          line('Loss avg / max', ls ? `${fmtPct(ls.avg)} / ${fmtPct(ls.max)}` : '-'),
          line('Bandwidth', last ? `↓${fmtBw(last.bwIn)} ↑${fmtBw(last.bwOut)}` : '-'),
          line('Codec', lastMeta && lastMeta.codec ? `${lastMeta.codec}${lastMeta.quality != null ? `, quality ${lastMeta.quality}/10` : ''}` : '-'),
          line('Channel', lastMeta && lastMeta.channelName || '-'),
        );
      }

      /* ---- diagnostics text (copied to the clipboard, never logged) ---- */
      function diagnostics() {
        const v = api.version(), m = api.net.meta() || {}, ps = stat(samples.map(x => x.ping)), ls = stat(samples.map(x => x.loss)), last = samples[samples.length - 1];
        const r = (x, f) => (x == null ? 'n/a' : f(x));
        return [
          'TeamSpeak connection diagnostics',
          `Client: ${v.client || 'unknown'}${v.build ? ' (build ' + v.build + ')' : ''}, UI engine Chrome ${v.chrome || 'unknown'}`,
          `OS: ${osName()}`,
          `Server: ${m.serverVersion || 'unknown'} on ${m.serverPlatform || 'unknown'}`,
          `Channel codec: ${m.codec || 'unknown'}${m.quality != null ? ', quality ' + m.quality + '/10' : ''}`,
          `Samples: ${samples.length} over ${samples.length > 1 ? Math.round((samples[samples.length - 1].t - samples[0].t) / 1000) : 0} s (interval ${S().interval} s)`,
          `Ping ms (min/avg/max/now): ${ps ? [ps.min, ps.avg, ps.max].map(x => Math.round(x * 10) / 10).join('/') : 'n/a'}/${r(last && last.ping, x => Math.round(x * 10) / 10)}`,
          `Jitter ms: ${r(last && last.jitter, x => x.toFixed(2))}`,
          `Packet loss % (avg/max/now): ${ls ? [ls.avg, ls.max].map(x => x.toFixed(2)).join('/') : 'n/a'}/${r(last && last.loss, x => x.toFixed(2))}`,
          `Bandwidth now: in ${r(last && last.bwIn, fmtBw)}, out ${r(last && last.bwOut, fmtBw)}`,
        ].join('\n');
      }
      async function doCopy() {
        const ok = await copyText(diagnostics());
        copyBtn.setAttribute('data-copied', ok ? 'ok' : 'fail');
        copyBtn.textContent = ok ? 'Copied' : 'Copy failed';
        api.timeout(() => { copyBtn.textContent = 'Copy diagnostics'; copyBtn.removeAttribute('data-copied'); }, 1800);
      }

      /* ---- alerts: N consecutive samples over the threshold, re-armed below 80 % of it, at most one toast per metric per minute ---- */
      function checkAlerts(x) {
        const s = S(); if (!s.alert) return;
        const test = (key, val, max, title, text) => {
          const a = alarm[key]; if (val == null) return;
          if (val > max) { a.n++; if (!a.on && a.n >= ALERT_SAMPLES) { a.on = true; if (Date.now() - a.at >= ALERT_COOLDOWN_MS) { a.at = Date.now(); api.toast(title, text); } } }
          else { a.n = 0; if (a.on && val < max * RECOVER) a.on = false; }
        };
        test('ping', x.ping, s.pingMax, 'High ping', `Ping is ${fmtMs(x.ping)} (alert above ${s.pingMax} ms).`);
        test('loss', x.loss, s.lossMax, 'Packet loss', `Packet loss is ${fmtPct(x.loss)} (alert above ${s.lossMax} %).`);
      }

      /* ---- polling ---- */
      async function tick() {
        if (busy) return;
        if (!api.net.connected()) { if (samples.length) samples = []; alarm.ping.n = alarm.loss.n = 0; renderHud(); return; }
        busy = true;
        try {
          const x = await api.net.poll();
          if (x) {
            samples.push(x); const cut = Date.now() - HISTORY_MS; while (samples.length && samples[0].t < cut) samples.shift();
            updates++; checkAlerts(x); if (popOpen) refreshMeta();
          }
        } finally { busy = false; }
        renderHud(); if (popOpen) renderPop();
      }
      function restart() {
        if (stopTick) stopTick();
        stopTick = api.interval(tick, Math.max(1, S().interval) * 1000);
        renderHud();
      }
      place(); restart(); tick();

      live = { apply: () => { place(); restart(); if (popOpen) renderPop(); }, teardown: () => { pop.remove(); hud.remove(); } };
    },
    disable() { if (live) { live.teardown(); live = null; } },
    settings(api, box) {
      const { ui } = api, S = () => Object.assign({}, DEFAULTS, api.storage.all());
      const put = (k, v) => { api.storage.set(k, v); live && live.apply(); };
      const s = S();
      box.append(
        ui.section('Display',
          ui.slider({ label: 'Update interval', min: 1, max: 5, step: 1, unit: 's', value: s.interval, help: 'How often connection statistics are requested.', onInput: v => put('interval', v) }).el,
          (() => { const pills = [['bottom', 'Bottom bar'], ['top', 'Top bar']].map(([v, label]) => { const p = ui.pill({ label, on: s.position === v, onClick: () => { put('position', v); pills.forEach(x => x.p.set(x.v === v)); } }); p.el.setAttribute('data-pos', v); return { v, p }; });
            return ui.h('div', { class: 'mods-row', title: 'Bottom bar: next to the connection status under the channel tree. Top bar: next to the microphone and speaker buttons.' }, ui.h('span', { class: 'mods-label' }, 'Position'), ...pills.map(x => x.p.el)); })(),
          ui.toggle({ title: 'Show bandwidth', sub: 'Incoming and outgoing data rate next to ping and loss.', checked: s.bandwidth, onChange: v => put('bandwidth', v) }).el),
        ui.section('Alert limits',
          ui.toggle({ title: 'Alerts', sub: 'A notification when ping or packet loss stay above the limits below (at most one per minute and metric).', checked: s.alert, onChange: v => put('alert', v) }).el,
          ui.slider({ label: 'Ping limit', min: 30, max: 1000, step: 10, unit: 'ms', value: s.pingMax, onInput: v => put('pingMax', v) }).el,
          ui.slider({ label: 'Loss limit', min: 1, max: 50, step: 1, unit: '%', value: s.lossMax, onInput: v => put('lossMax', v) }).el),
        ui.note('The readout appears while you are connected. Click it for the history graph, codec and the copy-diagnostics button.'),
      );
    },
  });
})();
