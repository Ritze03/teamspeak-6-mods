// Consumer/provider interplay, in both enable orders; disabling either side leaves no trace.
export default async function (ctx) {
  const banners = () => ctx.eval(`[...document.querySelectorAll('.example-banner')].map(n => n.getAttribute('data-from') + ':' + n.textContent).sort()`);
  for (const order of [['ext-provider', 'ext-consumer'], ['ext-consumer', 'ext-provider']]) {
    ctx.log('enable order: ' + order.join(' -> '));
    for (const id of order) await ctx.enable(id);
    ctx.equal(await banners(), ['ext-consumer:Hello, consumer!', 'ext-consumer:consumer is here'].sort(), 'both consumer banners attached (' + order.join(',') + ')');
    await ctx.disable('ext-provider');
    ctx.equal(await banners(), [], 'provider off: slot and extension are gone');
    await ctx.assertClean('ext-provider');
    await ctx.enable('ext-provider');
    ctx.equal((await banners()).length, 2, 'provider back: queued consumer items attach again');
    await ctx.disable('ext-consumer');
    ctx.equal(await banners(), [], 'consumer off: its banners are detached');
    await ctx.assertClean('ext-consumer');
    await ctx.disable('ext-provider');
    await ctx.assertClean('ext-provider');
  }
}
