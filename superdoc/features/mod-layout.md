# Layout mod (`panel/mods/layout/`)

Three independent layout features behind one mod switch (default off, like every mod; see [ts6-mod-api.md](ts6-mod-api.md)).
Inside the mod every feature has its own switch and starts off, so enabling the mod alone changes nothing.
All TeamSpeak names live in `panel/core/x-layout.js` (core extension file, `api.layout`); `panel/mods/layout/index.js` and
`style.css` contain none.

## What it does

1. **Chat tabs in the title bar.** A strip of 36 px high tabs (the client's bar height) sits in the free part of the title bar,
   between the central toolbar and the window buttons. One tab per open chat: click shows that chat, the x button closes it
   (the client's own close action), the active tab has an accent border, a count badge shows unread messages. While tabs are on,
   the left column is collapsed to its 62 px icon column; switching tabs off (or the mod) puts it back exactly as it was (if it
   was already collapsed it stays collapsed).
2. **Servers as tabs too** (own switch): one tab per connected server in front of the chat tabs; click shows the server. No x
   (closing would disconnect).
3. **Density slider** (60-140 %, default 100 = vanilla): scales the channel tree row heights live, no restart. Chat spacing is not
   touched.
4. **Hide switches** (10), each hides exactly one element by CSS: announcement bar above the tree ("Is this your server?"),
   server banner card on the info page, "File Transfer Info" card, Create Channel button, AFK button, "Create a TeamSpeak
   Community" button, Bookmarks section, Dashboard "Start your own Community" banner, Dashboard Popular Servers, Dashboard Chats
   (both Dashboard hide switches together hide the whole servers card).

## Settings (`api.storage`, mod id `layout`)

`chatTabs` (bool), `serverTabs` (bool), `density` (number, percent), `hide` (`{key: true}`, keys: `announce hostBanner transfer
createChannel afk join bookmarks dashStart dashPopular dashChats`). Defaults: false, false, 100, `{}`.

## Mechanism

| Piece | How (anchored in `x-layout.js`) |
|---|---|
| open chats | the sidebar list component's `openedActivityGroups` (anchor `layout.activities`); chat items have `type` other than `connection`, `displayName`, `isActive`, unread in `client.chat.unread_message_count`; watched with a root `$watch` plus the shared DOM observer (the component can be rebuilt) |
| show / close | `appController.showItem(item)` and the list component's `itemClosed(item)` (what its x button runs; also moves to the previous activity when closing the shown one) |
| tab strip | fixed-position element in `body`, placed from the rects of the central toolbar and the window-button item (`api.layout.frame.rect`); re-placed on resize, ResizeObserver of the bars and a `$watch` of the layout slot sizes |
| sidebar | window component `windowLayout.setSlotCollapsed(0, bool)` (anchor `layout.window`); the original state is recorded and restored through a ledger entry |
| density | the tree component reads `--ts-tree-*-height-*` once at mount into data fields and the cache refresh is broken. So: override the four CSS vars with `calc((<original raw value>) * f) !important` (original read from the computed custom property), measure each var with a hidden probe element, write the numbers into the tree component's fields and call its `flattenServer()`. New trees pick the vars up on their own. Undo removes the style and re-measures |
| hide | one `<style>` from `api.layout.declutter.css(keys)` |

Why: a tab strip as an overlay computed from rects (instead of injecting into the bar) because the strip should span the free
width even when the bar is split over two panes. Why collapse the sidebar: the user's spec (tabs replace the wide chat list).
Why the `layout` density restores via re-measure: the stock cache cannot be refreshed, so heights are pushed into the component.

## Test procedure

Automatic: `node tools/test/run-all.mjs --cdp-port <cdp> --control-port <ctl> --only layout` (`panel/mods/layout/test.mjs`),
against a client connected to a server with at least one other user (the test sends "layout test" as a private message to up to
two users; without another user the chat part logs a skip). It checks: no strip while off; chat tabs on -> sidebar 62 px, one
tab per open chat, click switches the active tab, x closes the chat in the client; off -> sidebar width restored, clean ledger;
server tabs and their click; density 70 % shrinks rows live and off restores them; the Mods page slider (130 %) enlarges rows;
every hide key hides all matching elements and off restores them (elements not on screen are skipped with a log line).
Hide targets exist on the server view (tree/info page) and on the Dashboard; the test visits both.
The test edits the stored `layout` settings only in memory and restores them; driving the slider writes the settings blob
(density back at 100); run-all puts the persisted blob back at the end.
Not on the local test server (`ctx.onTestServer()` false) the chat-tab part only counts the open chats and checks their tabs,
never opens a private chat (`x-layout.js:openChats(n>0)` itself refuses unless every connection is local). Hide keys the client
or theme already hides while the mod is off are only checked for "hidden while on" (graphite hides the join button).

Manual: unread badge (let another user write to you while another tab is shown), many tabs (the strip scrolls with the wheel),
custom themes.

## Known limits

- Unread badges and the graphite/aurora look were not verified live (tokens only; unread logic is a read of the chat's counter).
- The strip hides itself when the free title-bar zone is under 60 px.
- Hiding the announcement bar leaves the tree header offset as in vanilla.
- Debug/test hook: `window.__ts6modLayoutDev` (x-layout.js) used by the test; harmless without it.
