// Dashboard mod: enable -> button in the left icon column; click -> Dashboard route; disable -> no trace.
export default async function (ctx) {
  const BTN = '[data-ts6mod="dashboard"]';
  await ctx.disable('dashboard');   // start from "off" whatever the user has switched on (the runner restores the switch afterwards)
  ctx.equal(await ctx.eval(`document.querySelectorAll('${BTN}').length`), 0, 'no button while the mod is off');
  await ctx.enable('dashboard');
  await ctx.waitFor(`document.querySelectorAll('${BTN}').length === 1`, 'button appears');
  ctx.equal(await ctx.eval(`document.querySelector('${BTN}').title`), 'Dashboard', 'button has the Dashboard title');
  ctx.equal(await ctx.eval(`__ts6mod.route().path !== '/dashboard'`), true, 'not on the Dashboard before the click');
  await ctx.eval(`document.querySelector('${BTN}').click()`);
  await ctx.waitFor(`__ts6mod.route().path === '/dashboard'`, 'click navigates to the Dashboard route');
  await ctx.waitFor(`document.querySelector('${BTN}').classList.contains('active')`, 'button is highlighted on the Dashboard');
  await ctx.restoreRoute();
  await ctx.waitFor(`!document.querySelector('${BTN}').classList.contains('active')`, 'highlight goes away when leaving the Dashboard');
  await ctx.disable('dashboard');
  ctx.equal(await ctx.eval(`document.querySelectorAll('${BTN}').length`), 0, 'button removed on disable');
  await ctx.assertClean('dashboard');
}
