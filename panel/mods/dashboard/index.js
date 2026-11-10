/* Dashboard mod: a Dashboard button (home / start page) in the left icon column. Same action as the Dashboard entry of the
 * main menu. Docs: superdoc/features/mods-panel.md ("Dashboard button"). */
ts6mod.register({
  id: 'dashboard',
  title: 'Dashboard button',
  description: 'Adds a Dashboard button (home / start page) to the left icon column. Same as the Dashboard entry of the main menu.',
  enable(api) {
    api.sidebar.addIcon({
      title: 'Dashboard', icon: 'dashboard',
      onClick: () => api.nav.showDashboard(),
      active: () => api.nav.onDashboard(),   // highlighted while the Dashboard is displayed
    });
  },
});
