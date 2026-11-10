/* Dashboard mod: a Dashboard button (home / start page) in the left icon column. Same action as the Dashboard entry of the
 * main menu. Docs: superdoc/features/mods-panel.md ("Dashboard button"). */
ts6mod.register({
  id: 'dashboard',
  title: 'Dashboard button',
  group: 'Interface', order: 3,
  icon: 'M4 4h7v7H4z M13 4h7v7h-7z M4 13h7v7H4z M13 13h7v7h-7z',
  summary: 'A direct button to the Dashboard in the left column.',
  description: 'Adds a Dashboard button (home / start page) to the left icon column. Same as the Dashboard entry of the main menu.',
  enable(api) {
    api.sidebar.addIcon({
      title: 'Dashboard', icon: 'dashboard',
      onClick: () => api.nav.showDashboard(),
      active: () => api.nav.onDashboard(),   // highlighted while the Dashboard is displayed
    });
  },
});
