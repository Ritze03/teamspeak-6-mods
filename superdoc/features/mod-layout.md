# Layout mod (`panel/mods/layout/`)

Independent layout features behind one mod switch (default off, like every mod; see [ts6-mod-api.md](ts6-mod-api.md)).
Inside the mod every feature has its own switch and starts off; the one exception is the Create Channel button's collapsed shape
(feature 4: with the mod on, the stock auto-collapsed button is drawn as a circle).
All TeamSpeak names live in `panel/core/x-layout.js` (core extension file, `api.layout`); `panel/mods/layout/index.js` and
`style.css` contain none.

## What it does

1. **Chat tabs in the title bar.** A strip of 36 px high tabs (the client's bar height) in the title bar above the chat pane. While
   tabs are on, the left column is collapsed to its 62 px icon column; switching tabs off (or the mod) puts it back exactly as it was
   (if it was already collapsed it stays collapsed).
   - **Aligned with the chat pane.** The strip's left edge is the x where the chat pane's content starts (its header item, where the
     channel icon and name and the messages begin), so the tabs sit on top of the chat like tabs. It follows live when the tree pane
     is resized, the window resizes, or the sidebar collapses / expands. It never starts left of the central toolbar (AFK, mic,
     speaker, and the net mod's readout when that is set to the top bar) + 12 px; then it starts there instead. The space between the
     toolbar and the strip is untouched title bar, so it still drags the window. Without a chat pane (Dashboard, Settings) the strip
     stays at the last x measured off a visible chat pane (`tabsX`, so it does not move when Settings opens, also after a restart
     into Settings); with no stored value yet it starts after the toolbar. A stale x never lets it overflow the right edge. Narrow window: tabs shrink (chat tabs down to 70 px, the pinned tab to 90 px), then the strip
     scrolls (mouse wheel; the active tab is scrolled into view); under 60 px of room the strip hides.
     Why (stays put without a chat pane): the user does not want the tabs to jump left when entering Settings.
     Why: the user wants the tabs to read as the chat's tabs ("at the same horizontal coordinate as where the actual chat starts").
   - **First tab = the chat of your current channel** (pinned): channel icon + channel name; click shows that channel's chat (the
     stock "Show current Channel Chat" action); it follows the own channel live (label, target and unread count change on a channel
     move); it is always leftmost, has no x and cannot be dragged; it is active when the current channel's chat is the shown view.
     When the client also lists the current channel's chat as an open chat (it does after a message in that channel), that chat gets
     no tab of its own: the pinned tab stands for it. No server tabs any more.
     Why (user): "the server has no chat of its own; the first tab should always be the current channel". The old server tab only
     showed the server; the tree pane is visible next to the chat anyway.
   - **Other open chats** (private chats, other channels' chats) follow, after a divider: click shows the chat, the x closes it (the
     client's own close action), a count badge shows unread messages, the shown one has an accent border.
   - **Reorder by drag** (chat tabs only): press on a tab (not on its x) and move 5 px; the tab dims and an accent line shows where it
     will land; release drops it. The drag never counts as a click. Near the strip's ends it scrolls. New tabs append at the end; a
     tab closed while its server is connected drops out of the saved order (it comes back at the end).
   - **Several servers:** the pinned tab belongs to the active server (the one whose tree is shown; the client's `isActiveServer`) and
     shows that server's current channel; with more than one server connected it also shows the server name (small, muted) and its
     tooltip names the server. Chats of every server stay in the strip. Switching servers is done with the server icons in the
     collapsed left column (it lists each connected server; clicking one makes it active, and the pinned tab follows).
     Why not a server switch in the tab: the icon column already does it with the client's own UI, and a server entry in the strip
     is exactly what the user asked to remove. Not verified live with two servers (a second connection to the same local test server
     does not connect); the logic is the stock active-server flag.
2. **Density slider** (60-140 %, default 100 = vanilla): scales the channel tree row heights live, no restart. Chat spacing is not
   touched.
3. **Hide switches** (9), each hides exactly one element by CSS: announcement bar above the tree ("Is this your server?"),
   server banner card on the info page, "File Transfer Info" card, AFK button, "Create a TeamSpeak
   Community" button, Bookmarks section, Dashboard "Start your own Community" banner, Dashboard Popular Servers, Dashboard Chats
   (both Dashboard hide switches together hide the whole servers card).
4. **Create Channel button** (bottom bar of the channel tree pane), three styles:
   - **Vanilla** (default): the stock button. The client folds its label away when the pane is too narrow (see Mechanism); stock
     draws the folded button as a 42x30 stadium, the mod draws it as a 30 px circle. The expanded pill is untouched.
   - **Compact**: always the 30 px circle with the plus icon, label hidden; same click (it is the stock button).
   - **Hidden**: no button (the old "Create Channel button" hide switch).
   In Vanilla and Compact the button gets the localized label as `title`/`aria-label` (the stock button has neither, so the
   circle would otherwise have no tooltip or accessible name).
   Why the circle fix belongs to Vanilla: the user asked for the stock auto-collapse to stay but to end as a full circle; Vanilla is
   "the stock behaviour" and the round collapse is the only change it makes. Compact is "always folded". Mod off = the stadium again.

## Settings (`api.storage`, mod id `layout`; Settings -> Mods -> Layout card -> its page, boxes Tabs, Density, Create Channel button, Hide: <group>)

`chatTabs` (bool), `tabsX` (number, last measured chat content x, written by the mod only), `tabOrder` (array of chat keys `<server uuid>|u:<client unique id>` or `<server uuid>|c:<channel id>`, the saved
order of the chat tabs; written only by a drop or by closing a tab that is in it), `density` (number, percent), `ccStyle` (`vanilla | compact | hidden`, three pills),
`hide` (`{key: true}`, keys: `announce hostBanner transfer afk join bookmarks dashStart dashPopular dashChats`).
Defaults: false, `[]`, 100, `vanilla`, `{}`. An old stored `serverTabs` is ignored (server tabs were replaced by the pinned tab).
Why keys of server uuid + client uid / channel id: the client's activity ids (`chat12`) are per session; uid and channel id stay the
same across restarts. Why prune only on close while the server is connected: chats of a server that is not connected (yet) keep
their place for when they come back.
Migration (`index.js:ccOf`): without a stored `ccStyle`, an old `hide.createChannel: true` means Hidden. Nothing is written on
enable; the old key is dropped from the stored `hide` set the first time a style pill is clicked. Why lazy: enabling the mod must not
rewrite the settings blob.

## Mechanism

| Piece | How (anchored in `x-layout.js`) |
|---|---|
| open chats | the sidebar list component's `openedActivityGroups` (anchor `layout.activities`); chat items (`type` `chat`) carry `client` (private chat) or `channel` (channel chat; the client adds one to `appController.directChats` when a message arrives in or is sent to the own channel, and drops the old channel's on a move), `displayName`, `isActive`, unread in `client/channel.chat.unread_message_count`; watched with a root `$watch` plus the shared DOM observer (the component can be rebuilt) |
| pinned tab | anchor `layout.ownChannel`: the connection with `isActiveServer` (else the shown one, else the first connected) and its `currentChannelItem` (= `ownClient.GetChannel()`). Show = `appController.showItem(channel, 'Chat')`, active = `connection.activeDetailItem === channel && channel.lastContentModeKey === 'Chat' && appController.currentActivity === connection && !hasSlideoverVisible`, unread = `connection.unreadChannelMessageCount`: the same code as the stock "Show current Channel Chat" toolbar button (`currentChannelToolButton`). The chat item whose `channel` is that channel is left out of the list (`x-layout.js:snapshot`) |
| show / close | `appController.showItem(item)` and the list component's `itemClosed(item)` (what its x button runs; also moves to the previous activity when closing the shown one) |
| tab strip | fixed-position element in `body`, placed by `api.layout.frame.rect`: left = the chat pane's content start (anchor `layout.chatPane`: the visible `.tsv-activity-detail`, content start = its `.tsv-content-header-bar > .tsv-bar-item`, else pane left + 10), but at least the central toolbar's right edge + 12; right = the window-button item - 12. Re-placed on window resize, a ResizeObserver on the root, the title bars, the sidebar, the chat pane and the toolbar (`frame.onChange`; `frame.rewatch()` adds elements rebuilt later, called from the DOM observer), and a `$watch` of the layout slot sizes (tree pane drags) |
| reorder | pointer events on each chat tab (`index.js:dragStart/dragMove/dragEnd`, pointer capture on the tab, 5 px threshold, `.lay-drop` line positioned from the tabs' `offsetLeft`); a render during a drag is deferred to the drop; a click within 250 ms after a drop is ignored. Order = saved keys first, unknown tabs after them in the client's order (`index.js:ordered`) |
| sidebar | window component `windowLayout.setSlotCollapsed(0, bool)` (anchor `layout.window`); the original state is recorded and restored through a ledger entry |
| density | the tree component reads `--ts-tree-*-height-*` once at mount into data fields and the cache refresh is broken. So: override the four CSS vars with `calc((<original raw value>) * f) !important` (original read from the computed custom property), measure each var with a hidden probe element, write the numbers into the tree component's fields and call its `flattenServer()`. New trees pick the vars up on their own. Undo removes the style and re-measures |
| hide | one `<style>` from `api.layout.declutter.css(keys)` |
| Create Channel | bottom bar `.ts-server-status-bar` (component `server-status-bar`, anchor `layout.statusBar`): `isSmall = bar content width < width of a hidden always-titled copy of the button group (.ts-hidden, visibility hidden) + right group`, fed by a ResizeObserver; with `isSmall` the visible group is rendered with `show-with-title=false` (no `.tsv-tool-button-title` child). So the collapse trigger is the bar width vs. the measured widths, not a container query or class. The mod adds one `<style>` from `api.layout.createChannel.css(style)`: Vanilla matches the visible button only `:not(:has(.tsv-tool-button-title))`, Compact always plus hides the title, Hidden hides every `.ts-server-status-constructive-buttons` (measuring copy too, so the right group gets the room). `api.layout.createChannel.label()` (re-run on DOM changes) sets title/aria-label, its ledger entry removes them (anchor `layout.createChannel`) |

Why: a tab strip as an overlay computed from rects (instead of injecting into the bar) because the title bar is split over two
panes (the toolbar sits in the tree pane's bar, the window buttons in the chat pane's) and the strip has to line up with the chat
pane's content, not with a bar element. Why `max(chat start, toolbar end + 12)`: with a narrow tree pane the toolbar reaches past
the chat start; overlapping the toolbar (or the net mod's top-bar readout inside it) is worse than a misaligned strip. Why collapse the sidebar: the user's spec (tabs replace the wide chat list).
Why the `layout` density restores via re-measure: the stock cache cannot be refreshed, so heights are pushed into the component.

## Test procedure

Automatic: `node tools/test/run-all.mjs --cdp-port <cdp> --control-port <ctl> --only layout` (`panel/mods/layout/test.mjs`),
against a client connected to a server with at least one other user (on the local test server the test sends "layout test" as a
private message to up to two users and into channels, moving its own client; without another user the chat part logs a skip). It
checks: no strip while off; chat tabs on -> sidebar 62 px, no server tab, one pinned tab leftmost without x showing the own channel
name, its click makes it active; the strip's left edge equals the chat pane's content start (when that is right of the toolbar)
and follows a tree pane resize; (local) the own channel's chat gets no second tab, a channel move updates the pinned tab; one tab
per other open chat, click switches the active tab (pinned off), a pointer drag of the last chat tab in front of the first
reorders, removes the drop line, saves `tabOrder` and does not count as a click; x closes the chat in the client; closing all
empties `tabOrder`; the pinned tab is not active on the Dashboard and its click brings the channel chat back; off -> sidebar width
restored, clean ledger; density 70 % shrinks rows live and off restores them; the Layout page slider (130 %) enlarges rows;
every hide key hides all matching elements and off restores them (elements not on screen are skipped with a log line).
Hide targets exist on the server view (tree/info page) and on the Dashboard; the test visits both.
The test edits the stored `layout` settings only in memory and restores them; driving the slider writes the settings blob
(density back at 100); run-all puts the persisted blob back at the end.
Not on the local test server (`ctx.onTestServer()` false) the chat-tab part only counts the open chats and checks their tabs,
never opens a private chat (`x-layout.js:openChats(n>0)` itself refuses unless every connection is local). Hide keys the client
or theme already hides while the mod is off are only checked for "hidden while on" (graphite hides the join button).

Create Channel part: wide pane (>= 520 px, set through the layout slot like a divider drag, not saved): Vanilla leaves the pill
as stock, title set; pane at its minimum (220 px): stock collapse, button is a circle (width = height), right group inside the bar;
Compact: circle, no label, title kept; Hidden: not displayed; an old `hide.createChannel` without `ccStyle` = hidden; off: stock pill,
no title, clean ledger; the Layout page has the three pills with Vanilla on. The pane width is restored afterwards.

Manual: unread badge (let another user write to you while another tab is shown), many tabs (the strip scrolls with the wheel),
custom themes, two servers (pinned tab follows the server picked in the icon column, server name shown in it).
Checked live (isolated client, 1920x1080 viewport, default theme and the graphite base CSS): strip aligned with the chat header at
two tree-pane widths, pinned tab follows a move, mouse drag reorders with the drop line, pinned / private tab highlight; read-only
on a real client (dark custom theme) after a hot swap.

## Known limits

- The pane-width test helper (`__ts6modLayoutDev.paneWidth`) resizes the main pane live while the test runs (restored, not saved).

- Unread badges and the aurora look were not verified live (tokens only; unread logic is a read of the chat's counter).
- Two connected servers were not verified live (see feature 1, "Several servers").
- The strip hides itself when the free title-bar zone is under 60 px.
- Leaving a channel: the client itself drops that channel's chat item, so other channels' chats rarely stay as tabs; a private
  chat or a channel chat of another server does.
- With a narrow tree pane the toolbar can reach past the chat pane's start; the strip then starts after the toolbar (not aligned).
- Hiding the announcement bar leaves the tree header offset as in vanilla.
- Debug/test hook: `window.__ts6modLayoutDev` (x-layout.js) used by the test; harmless without it.
