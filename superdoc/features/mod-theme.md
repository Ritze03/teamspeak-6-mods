# Mod: theme (theme tools)

A helper for theme developers (and anyone who switches themes a lot). Switch the client's extension theme from the Mods page,
reload the active theme with one click, or turn on **live reload**: the active theme file is polled and edits are applied
without a restart, including changed tree row heights. Mod id `theme`, code `panel/mods/theme/`, TS-specific part
`panel/core/x-theme.js`. API background: [ts6-mod-api.md](ts6-mod-api.md).

## Settings (Mods page, shown while the mod is on)

| Setting | Default | Meaning |
|---|---|---|
| mod switch | off | off = nothing at all (vanilla) |
| Theme picker | current | "Default (no extension theme)" + every installed extension theme, grouped by extension; switching goes through the client's own theme setting (so it persists like picking it in Appearance) |
| Rescan themes | - | ask the client to re-read the installed list (see limits) |
| Reload theme now | - | one-shot: re-read the active theme (cache-busted), swap it in, re-measure the tree |
| Live reload | off | poll the active theme while on; zero polling when off. Stored per mod (`live`) |
| Poll interval | 1000 ms | 250-5000 ms (`ms`); shown while live reload is on |

With the mod on but live reload off nothing is injected and no timer runs.

## Mechanism

- **Active theme**: the client keeps one `<link>` for the active extension theme (`appController.applyUserStyle(id)` sets its
  `href`, `disableUserStyle()` removes it; id is `<extension id>//<theme name>`; the choice is in
  `appearanceSettings.user_style`). Installed themes come from `getUserStyles()` (native `getInstalledThemes`).
  Anchors: `theme.controller`, `theme.link`, `theme.tree` (`x-theme.js`); API `api.theme.{list,current,apply,rescan,check,reset,remeasure,state,activeSource}`.
- **Reading the file**: a theme is `tsui://extension/<id>/<file>.css?v=<start time>`. A plain `fetch` is blocked, but
  `fetch(url, {mode:'no-cors', cache:'no-store'})` with a cache-busting query returns the text. Themes pull their body in with
  `@import url(Base.css?v=N)`, so `x-theme.js:flatten` follows the import chain (depth 6) and makes relative `url()` absolute.
- **Swap**: the flattened CSS goes into a `<style data-theme-live>` placed right after the client's link (same cascade position),
  and the link is set `disabled`. Disable of the mod removes the style and re-enables the link (ledger entry `theme-live-style`).
  Why a flattened `<style>` and not a new `<link href=...?bust>`: imports inside it would come from the HTTP cache and the very
  file people edit (the base) would not reload.
- **Change detection**: `api.theme.check()` compares the flattened text (and link href) with the previous read. The first read
  after enabling/toggling is only a baseline (no swap). A changed theme (edit, or a different theme picked) swaps and re-measures;
  with no extension theme active the live style is dropped.
- **Tree re-measure**: the server tree component reads `--ts-tree-{client-compact,client-default,channel-default,spacer-default}-height`
  once in `mounted()` into data fields (`clientHeightCompact`, `clientHeightDetailed`, `channelHeightDefault`, `spacerHeightDefault`).
  The client's own `variableCache.recomputeCache` iterates a `Map` with `for..in` and never refreshes anything, and re-querying the
  cache returns wrong numbers (its measuring clone is stale). Working trick (`x-theme.js:treeRemount`): measure each variable with a
  hidden probe `<div>` (width = `var(--name)`) inside the tree's container, assign the four fields, call the component's
  `flattenServer()` and the virtual list's `refreshHeightCache()`. Verified: rows resize live.
- **Why polling, no file watcher** (D14): no native changes and zero cost when off.

Note: themes need `!important` on `:root` variables because the client injects its defaults after the theme link; the live style
sits at the link's position so it behaves the same.

## Test procedure

Switching the theme from the picker re-measures the tree afterwards (400 ms and 1.2 s), because the client keeps the old theme's
row heights cached and rows overlap until a restart otherwise (seen switching graphite -> default).

Automatic: `TS6MOD_PROFILE_DIR=<profile> node tools/test/run-all.mjs --cdp-port <cdp> --control-port <ctl> --only theme`
(`panel/mods/theme/test.mjs`). It copies the installed graphite theme from the real extensions folder (read-only source) into
`<profile>/config/TeamSpeak/Default/extensions/`, edits **its copy** (tree row heights + a marker variable in the imported base file),
and checks: off = no live style/timer; picker default <-> graphite; the Reload button; live reload (300 ms poll) applies
28 -> 44 -> 34 px client row height and the marker without a restart, one live style only; switching to the default drops it;
disable = `assertClean`, later file edits ignored. The copy is restored at the end. The file part runs only when
`ctx.clientProfile().isolated` (the client process's config dir is not the user's own); against the real profile it is a SKIP and
only the picker, Reload and live-reload-without-edit checks run, and the original theme is asserted at the end. The test never
writes outside the isolated extensions folder (`restore()` refuses).
Prerequisites: (1) the client must have been **started** with the themes already in the profile (it lists installed themes once at
start): copy `~/.config/TeamSpeak/Default/extensions` into the profile before `launcher/ts6-mod`; (2) the client connected to a server
and the window large enough to show the tree (run-all sets a 1280x800 metrics override over CDP when the page is narrower and clears
it at the end; a fresh profile's window is tiny; the test no longer sets its own).
Manual: Mods page -> Theme tools on; pick a theme; edit a theme file, hit "Reload theme now" (or enable live reload) and watch colours and
tree rows change.

## Known limits

- The installed-theme list is cached by the client at start (`?v=` is the process start time); a theme folder added later is not
  listed until a restart. Editing files of listed themes is live. "Rescan themes" only helps if the client re-reads.
- Only plain `@import url()` / `@import "..."` (no media/layer conditions) are inlined.
- `tsui://` fetch relies on the no-cors read; if a client update blocks it, `check()` reports the error on the Mods page.
- The built-in light/dark scheme is not part of the picker (only extension themes and the default).
