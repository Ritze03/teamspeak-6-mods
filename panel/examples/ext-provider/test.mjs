// The provider alone: extension + slot exist while enabled and disappear (with their DOM) when disabled.
export default async function (ctx) {
  await ctx.enable('ext-provider');
  ctx.equal(await ctx.eval(`__ts6mod.trace().exts.includes('greeter') && __ts6mod.trace().slots.includes('banner')`), true, 'extension and slot registered');
  const consumerApi = `__ts6mod.makeApi(__ts6mod.mods().get('ext-provider'), __ts6mod.makeLedger())`;   // any api sees the extension
  ctx.equal(await ctx.eval(`${consumerApi}.ext.greeter.greet('x')`), 'Hello, x!', 'api.ext.greeter works');
  await ctx.disable('ext-provider');
  ctx.equal(await ctx.eval(`__ts6mod.trace().exts.length + __ts6mod.trace().slots.length`), 0, 'extension and slot removed on disable');
  await ctx.assertClean('ext-provider');
}
