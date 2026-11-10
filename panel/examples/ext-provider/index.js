/* Example plugin (D18): PROVIDES an extension and a slot that other plugins can use.
 *  - api.extend('greeter', impl)  -> other mods get it via api.require('greeter', cb) / api.ext.greeter
 *  - api.defineSlot('banner', {attach})  -> other mods call api.slots.banner.add({text})
 * Consumers may be enabled before or after this mod: queued slot items attach once the slot exists. See ext-consumer. */
ts6mod.register({
  id: 'ext-provider',
  title: 'Example: extension provider',
  description: 'Sample plugin that adds a "greeter" API extension and a "banner" slot for other plugins (invisible).',
  enable(api) {
    api.extend('greeter', { greet: name => 'Hello, ' + name + '!' });
    api.defineSlot('banner', {
      attach(spec, ctx) {
        const node = api.el('div', { class: 'example-banner', hidden: true, textContent: spec.text });   // hidden: the example must not change the UI
        node.setAttribute('data-from', ctx.owner);
        document.body.appendChild(node);
        return { detach: () => node.remove(), update: s => { node.textContent = s.text; } };
      },
    });
  },
});
