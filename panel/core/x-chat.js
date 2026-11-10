/* Core extension file of the "chat" mod (split long messages): everything TeamSpeak-specific the mod needs.
 *   anchor  chat.composers   the message composer instances (optional: only while a chat is displayed)
 *   anchor  chat.hintHost    the strip above the input where previews live; the hint goes there (optional)
 *   api.chat.serverLimit(el?)        the limit the composer would enforce without this mod (server message limit)
 *   api.chat.raiseLimit(n | () => n) -> {remove}   raise the composer's input limit (restored on remove / disable)
 *   api.chat.hint(text | null, el?)  small note above the input of that composer (null removes it)
 *   api.chat.sendParts(el, parts, {delayMs}) -> Promise<number>   send several messages one after the other
 * Docs: superdoc/features/mod-chat.md. Mechanics were probed on the live client (see "Mechanism" there). */
(function (boot) {
  'use strict';
  const A = boot.anchors;
  A.def('chat.composers', 'message composers (.ts-chat-input-container vm with sendMessageContent and a maxInputLength computed), only while a chat is displayed',
    () => { const l = A.$$('.ts-chat-input-container').map(e => e.__vue__).filter(v => v && typeof v.sendMessageContent === 'function'); return l.length ? l : false; }, true);
  A.def('chat.hintHost', 'strip above the message input (previews / autocomplete live in it), only while a chat is displayed',
    () => A.$('.ts-chat-input-container .ts-chat-input-top-section') || false, true);

  const composers = () => A.$$('.ts-chat-input-container').map(e => e.__vue__).filter(v => v && typeof v.sendMessageContent === 'function');
  const isServerChat = vm => !!vm.chat;   // room (Matrix) chats have other limits: left alone
  const vmOf = el => {
    if (el && el.closest) { const c = el.closest('.ts-chat-input-container'); if (c && c.__vue__) return c.__vue__; }
    const all = composers();
    return all.find(v => v.$el.contains(document.activeElement)) || all[0] || null;
  };
  // the composer's own computed (server limit), read through the component definition so that our shadow does not hide it
  const stockLimit = vm => { const c = vm.$options.computed && vm.$options.computed.maxInputLength; const f = typeof c === 'function' ? c : c && c.get; return f ? f.call(vm) : null; };

  boot.core.coreApi('chat', (api, track) => ({
    serverLimit(el) { const vm = vmOf(el); return vm && isServerChat(vm) ? stockLimit(vm) : null; },

    raiseLimit(n) {
      const val = typeof n === 'function' ? n : () => n, shadowed = new Map();   // vm -> value currently shown
      const apply = () => {
        for (const vm of [...shadowed.keys()]) if (vm._isDestroyed) shadowed.delete(vm);
        for (const vm of composers()) {
          if (!isServerChat(vm)) continue;
          const want = Math.max(val(), stockLimit(vm) || 0);
          if (shadowed.get(vm) === want) continue;
          if (!shadowed.has(vm)) Object.defineProperty(vm, 'maxInputLength', { get: () => shadowed.get(vm), configurable: true });   // instance property over the prototype computed
          shadowed.set(vm, want);
          vm.$forceUpdate();   // the composer passes the value to its editor as a prop on render
        }
      };
      const un1 = api.onDom(apply, { debounce: 100 }), un2 = api.listen(document, 'focusin', apply, true);
      apply();
      return { remove: track('chat-limit', () => { un1(); un2(); for (const vm of shadowed.keys()) { if (vm._isDestroyed) continue; delete vm.maxInputLength; vm.$forceUpdate(); } shadowed.clear(); }) };
    },

    hint(text, el) {
      const vm = vmOf(el), host = vm && vm.$el.querySelector('.ts-chat-input-top-section');
      for (const old of A.$$('[data-chat-hint]')) if (!host || old.parentNode !== host || !text) old.__undo ? old.__undo() : old.remove();
      if (!text || !host) return;
      let n = host.querySelector(':scope > [data-chat-hint]');
      if (!n) {
        n = api.el('div', { class: 'mods-chat-hint' }); n.setAttribute('data-chat-hint', '1');
        n.__undo = track('chat-hint', () => n.remove()); host.append(n);
      }
      if (n.textContent !== text) n.textContent = text;
    },

    /* Send each part through the composer's own send path, one after the other: put it into the input, send, wait until the
     * server acknowledged it (the promise of the chat's SubmitMessage, captured by wrapping it for the duration), then wait delayMs.
     * Stops (returns the number sent) when the composer is gone, the chat changed or the mod was switched off. */
    async sendParts(el, parts, opts) {
      const vm = vmOf(el); if (!vm) throw new Error('no chat input is displayed');
      const target = vm.chat, delay = Math.max(0, (opts && opts.delayMs) || 0);
      const sleep = ms => new Promise(res => api.timeout(res, ms));
      const had = Object.prototype.hasOwnProperty.call(target, 'SubmitMessage'), orig = target.SubmitMessage;
      let pending = null;
      target.SubmitMessage = function (...a) { const p = orig.apply(this, a); pending = p; return p; };
      let sent = 0;
      try {
        for (const part of parts) {
          if (vm._isDestroyed || vm.chat !== target) return sent;
          if (sent > 0 && delay) await sleep(delay);
          if (vm._isDestroyed || vm.chat !== target) return sent;
          vm.msg = part; pending = null;
          await vm.sendMessageContent();
          sent++;
          if (pending) await Promise.race([Promise.resolve(pending).catch(() => {}), sleep(5000)]);   // acknowledged (or 5 s)
        }
      } finally { if (vm.msg === parts[parts.length - 1] && !vm._isDestroyed) vm.msg = ''; if (had) target.SubmitMessage = orig; else delete target.SubmitMessage; }
      return sent;
    },
  }));
})(window.__ts6modBoot);
