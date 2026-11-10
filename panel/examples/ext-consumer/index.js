/* Example plugin (D18): CONSUMES what ext-provider adds, whatever the enable order.
 *  - api.require('greeter', cb): cb runs now if the extension exists, otherwise as soon as a provider is enabled; the
 *    returned function runs when the provider goes away (or this mod is disabled).
 *  - api.slots.banner.add(spec): queued until some mod defines the slot, detached again when it is disabled. */
ts6mod.register({
  id: 'ext-consumer',
  title: 'Example: extension consumer',
  description: 'Sample plugin that uses the "greeter" extension and the "banner" slot of the provider example (invisible).',
  enable(api) {
    api.slots.banner.add({ text: 'consumer is here' });
    api.require('greeter', g => {
      const item = api.slots.banner.add({ text: g.greet('consumer') });
      return () => item.remove();
    });
  },
});
