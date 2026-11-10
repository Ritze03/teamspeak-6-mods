// Audio mod: enable -> its settings area on the Mods page; polling only while the page is shown; disable -> no trace.
// Reads only (never changes the native config or the stock TeamSpeak AGC settings).
export default async function (ctx) {
  const BODY = '[data-ts6mod="audio"]';
  let nativeUp = false;
  try { nativeUp = (await fetch(`http://127.0.0.1:${ctx.controlPort}/status`)).ok; } catch (e) { ctx.log('native control API not reachable on port ' + ctx.controlPort + ' (UI part only)'); }
  const reqs = () => ctx.eval(`__ts6mod.trace().nativeRequests`);

  await ctx.disable('audio');   // start from "off" whatever the user has switched on (the runner restores the switch afterwards)
  await ctx.enable('audio');
  ctx.equal(await ctx.eval(`document.querySelectorAll('${BODY}').length`), 0, 'no settings DOM until the Mods page is open');
  await ctx.openModsPage();
  await ctx.waitFor(`document.querySelectorAll('${BODY}').length === 1`, 'audio area on the Mods page');
  ctx.assert(await ctx.eval(`/Automatic Gain Control/.test(document.querySelector('${BODY}').textContent)`), 'stock AGC toggle is listed');
  if (nativeUp) {
    await ctx.waitFor(`/Better AGC/.test(document.querySelector('${BODY}').textContent) && !!document.querySelector('${BODY} .mods-meters') && !document.querySelector('${BODY} .mods-meters').closest('[hidden]')`, 'native AGC controls shown');
    const a = await reqs(); await ctx.sleep(700);
    ctx.assert(await reqs() > a, 'meters/status are polled while the page is shown');
  }
  await ctx.restoreRoute();
  await ctx.waitFor(`document.querySelectorAll('${BODY}').length === 0`, 'settings DOM removed when the page is left');
  await ctx.sleep(300);
  const b = await reqs(); await ctx.sleep(700);
  ctx.equal(await reqs(), b, 'no polling while the page is hidden');

  await ctx.openModsPage();
  await ctx.waitFor(`document.querySelectorAll('${BODY}').length === 1`, 'area is back');
  await ctx.disable('audio');
  await ctx.waitFor(`document.querySelectorAll('${BODY}').length === 0`, 'area removed on disable');
  await ctx.assertClean('audio');
  const c = await reqs(); await ctx.sleep(500);
  ctx.equal(await reqs(), c, 'no polling after disable');
}
