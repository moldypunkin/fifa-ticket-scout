# Changelog

All notable changes to FIFA Ticket Scout are documented here. Timestamps are in Eastern Time (ET).

---

## August 20, 2026 — v2.6.2

### Marketplace Adapters: SeatGeek, StubHub, Evenue, TickPick

Four more ticket sources alongside Ticketmaster, each following the same shape: an adapter that recognises the event page and resolves its id and identity, `injected.js` routing the capture, and `background.js` normalising the response into the `{ block, row, seat, area, category, price, exclusive }` records the dashboard already consumes.

`event-info.js` was factored out during the SeatGeek work so every adapter reads event name, date, and venue the same way — JSON-LD first, then `og:title`, then `document.title`.

Capture is passive wherever forging a request would mean impersonating a session. SeatGeek's page already fetches `/api/event_listings_v2` on load, so the extension reads that rather than issuing its own request and walking into `scrape_uuid`, Talos, and DataDome. StubHub and TickPick emit listings rather than individual seats, so a listing without enumerated seat numbers expands into that many rows with a blank seat and, for StubHub, a `seatRange` — inventory the dashboard should be counting is not dropped just because the seats are not named. Evenue ships a header row alongside its data and the seat payload prefixes sections with a level (`KU:101`), which is stripped to `101`.

*Written from the code and commit history rather than from release notes — worth a read before publishing.*

### Flat Per-Ticket Fees

Fees were modelled only as a per-site multiplier, which cannot describe Evenue: its price-level table quotes a base price and the site adds a fixed amount per ticket, so the whole board read low by the same dollar figure at every price point. `centsToUSD()` now applies a flat fee after the multiplier, via `FEE_FLAT_BY_SITE`.

**The evenue value is provisional and stays that way.** 5.00 was measured against one Virginia Tech event, not read from the source. The GraphQL payload does carry a `TIERED FEES` field, which looked like the real table — but logging its value showed it empty (`{}`) on this event, so the fee is not published anywhere the passive capture can see it. It is most likely a per-ticket service fee added at checkout.

That leaves a constant, and a per-SITE one standing in for what is really per-VENUE. It is wrong the moment a second school is tried. If it needs to vary, `scan_config` — already fetched from Supabase on every load — can carry it without a release.

### Evenue: Join Prices From the Price-Level Table

On Virginia Tech's Paciolan build every seat row carries `SLP_PRICE=null`, so all 63,225 rows were dropped and the popup sat on "Waiting for listings" against an event that plainly had seats. Kansas, the build this was written against, puts the price inline. VT instead carries it in a GraphQL payload at `data.discovery.eventDetailMPT[]`, under `PL_PT_PRICES` — price level by price type — with `PRICELEVELCD` on the seat row as the join key.

That payload is found by CONTENT — any object carrying `PL_PT_PRICES`, or both `SEASONCD` and `ITEMCD` — rather than by walking a path. Paciolan names its GraphQL result keys with a space in them: the container is literally `data["discovery eventDetailMPT"]`, not `data.discovery.eventDetailMPT`. A path lookup found nothing, logged the payload as unrecognised, and left the seat payload held for a table that never arrived.

It is then turned into a `priceLevel -> price` map stored on the game. When a seat row has no inline price, the level is looked up. `SEASONCD` + `ITEMCD` in the payload reconstruct the same event id the seat url produces (`F26` + `01` -> `F26:01`), so prices attach to the right event without depending on the url shape.

The inner structure of `PL_PT_PRICES` is not documented anywhere visible, so the extractor walks it and accepts what it finds: a flat `level -> price` map, a `level -> {priceType: price}` map (cheapest wins), or rows carrying the level and price as fields. Level keys are matched as one-to-three alphanumerics — the codes are `"1"`, `"12"`, `"A"` — because a looser pattern invented a bogus level out of a container name AND stopped the walk before reaching the real ones. When nothing usable comes out, the raw shape is logged rather than the event silently staying empty.

Cents versus dollars is decided once per map, from the numbers: any decimals mean dollars, otherwise a maximum at or above 2000 means cents. Getting that wrong is a 100x error on screen, so the decision is stated in the log next to the first few levels it produced.

Seat and price payloads can arrive in either order. Prices normally come first on this build, but when they do not the seat payload is held in memory and re-parsed once the table lands, rather than waiting for a reload.

The "not the seat array" log now describes bodies five levels deep rather than three, which is what it takes to see inside `PL_PT_PRICES` rather than just its name.

`describeShape()` recursed into arrays but not objects, so every GraphQL body logged as `{data}` and deepening it changed nothing — which cost a diagnostic round. It now recurses into both, which is what surfaced `PL_PT_PRICES` at all.

### Service Worker Logs Reach Download Logs

`injected.js` mirrored its console output into storage via `content.js`, so Download Logs showed the page side of a capture. The service worker wrote only to its own console, behind `chrome://extensions` → "service worker" — a place nobody thinks to look. The effect: a payload that was captured fine and then REJECTED by the parser produced exactly the same evidence as a capture that never happened.

`bgLog()` now writes both. Same 1000-line cap and batching as the page side.

The Evenue parse failures say what they actually found rather than only what was missing. Its header row is located by sniffing for known column names, so a school whose columns are named differently lands in the same branch as an empty event: the log now names the payload shape, lists each element's shape, and prints any element that looks like column names. A missing required column reports the columns that ARE present. The success line — seat count and row count — is relayed too, since that is the one that says parsing worked.

Paciolan's page makes ~18 calls to `/pac-api/consumer/gql`, so the "not the seat array" line is reported once per path rather than once per response.

### Evenue: Match Paciolan Endpoints Across Schools

Evenue support was confirmed against one school's instance (Kansas, `/event/F26/02`, `/pac-api/seat-availability/`), and the capture pinned that exact path. Paciolan builds differ between schools, so on another school a near-miss like `/pac-api/seat-availability-v2/` was invisible and the popup sat on "Waiting for listings…".

Capture now matches `/pac-api/` generally and lets the payload shape decide, which is what `background.js` was already checking. Event ids are pulled by `evenueEventIdFromUrl()`, which handles `event-id/<id>` in the path, `?eventId=` / `?event-id=` in the query, a colon-joined id sitting bare in the path, and the URL-encoded form of each — all normalising to `<season>:<code>` with any leading venue/distributor segment dropped (`977:F26:02` → `F26:02`).

A `/pac-api/` response that is NOT the seat payload now logs its path and top-level shape instead of being dropped in silence, and one that looks right but yields no event id says so by name.

The candidate-endpoint recorder no longer filters to JSON. Evenue is a legacy CGI platform whose inventory can arrive as server-rendered HTML, so a JSON-only filter went blind on exactly the site most likely to need it; content type is now recorded and reported alongside each candidate rather than used as a gate.

### Fix: Stale Event Name After an In-Page Navigation

Switching to another event without a full page reload left the popup showing the previous event's name over the new event's seats.

`readEventInfo()` reads JSON-LD first because it is structured and unambiguous. But sites render that block server-side and client-side routers generally do not replace it, so after an in-page navigation it still describes the event you came from. `og:title` is rendered the same way and goes stale with it.

A JSON-LD node is now trusted only when its own `url` (or `mainEntityOfPage`) points at the page actually being viewed. Comparison is on path plus the event-identifying query params — Evenue keys events off the query string while the others use the path — normalized for trailing slashes and case so cosmetic differences do not read as a different event. A node carrying no url of its own cannot be checked and is kept, since rejecting those would discard the only source on pages that work fine. When the page's own node is missing, the name falls back to `document.title`, which is the one thing a client-side router does keep current.

`background.js` now MERGES event info into the stored match instead of replacing it. The fallback read returns a name but no date or venue, and overwriting outright would null the venue and silently drop that event back to heuristic tiers. The game key is per-event, so what is already stored belongs to the same event and is safe to keep.

Known limitation: on an in-page navigation to an event never seen before, the name is correct but date and venue may be unavailable until a full reload, so tiering falls back to the heuristic. The Group by hint reports that as `unmapped · heuristic` rather than hiding it, and a reload fills it in permanently.

### CSV Filenames Name Their Source

Exports are now prefixed with the site they came from:

```
stubhub_Nebraska_Cornhuskers_vs__Iowa_Hawkeyes_20260820_1435.csv
tickpick_Nebraska_Cornhuskers_vs__Iowa_Hawkeyes_20260820_1435.csv
fifa-resale_Portugal_vs__Spain_20260820_1435.csv
fifa-lms_Portugal_vs__Spain_20260820_1435.csv
```

The site leads rather than trails so exports of one match from several sites sort together by source instead of interleaving. `resale` and `lms` get distinct tags — they are different FIFA sites with different prices, and the file's `# Site:` header already told them apart. An unrecognised site slugs its own name rather than going anonymous.

The slugs are a separate map from `SITE_BRANDS`, which is display copy ("StubHub Scout") and collapses resale and lms into one name.

### Fix: Venues Whose Key Carries a Disambiguator

Nebraska's 122 curated sections were not reaching the popup. TicketPortal stores that venue as `memorial stadium - ne` — a hand-typed suffix distinguishing it from every other Memorial Stadium — and no marketplace ever writes it, so `"Memorial Stadium"` matched nothing and fell back to the heuristic.

Venue matching already handled the incoming name being LONGER than the key (city suffixes). This is the reverse: the key is longer than the name. `venueKey()` now also indexes each key by its base name, the part before a trailing `" - "`, and resolves from there. Four venues in the current export are affected: `memorial stadium - ne`, `tiger stadium - baton rouge`, `the midland theatre - mo`, and `darrell k. royal - texas memorial stadium`.

Ambiguity is never guessed. A base name is only accepted when exactly one key carries it, or when exactly one candidate's disambiguator also appears in the incoming name — so `"Memorial Stadium, Champaign, IL"` picks Illinois, while a bare `"Memorial Stadium"` with two candidates stays unmapped and falls back to the heuristic. Labelling seats with another stadium's categories is worse than showing generic bands.

The no-separator shape is covered too: `"Memorial Stadium Lincoln, NE"` resolves the same way `"Bobby Dodd Stadium Atlanta, GA"` already did.

Phase 3 of the test suite now swaps in a fresh fixture object for every change rather than mutating the live one. `venueKey` and the base-name index both cache against the identity of `VENUE_TIER_DATA`, which is sound because the extension never mutates it — but an in-place edit in a test would have been served stale results and verified nothing.

### Fix: Scan Button Broken on the Passive-Capture Sites

`startScan()` branched for Ticketmaster and then fell through to the FIFA path for everything else. On StubHub, SeatGeek, Evenue, and TickPick that path looked for a `perfId` in the url, found none, picked whichever game happened to be first in storage, checked it for a `productId` those sites never have, and reported *"Browse to a match seat map first so the extension can detect the game IDs"* — a message about a mechanism that does not apply to them.

Those four sites have no scan to start: `injected.js` reads the inventory out of the page's own network traffic. So they now get their own branch that reloads the tab with `bypassCache: true`, which is what actually re-runs the capture, and says so. Cache bypass matters — a response served from cache never reaches the fetch hook, so a plain reload can look like a dead capture.

### Capture Diagnostics

The passive-capture pipeline failed silently in two different ways that looked identical to "this event has no seats": nothing matching `MATCH_PATTERNS` logged nothing at all, and a match that was not JSON landed in a bare `catch {}`.

Both are now reported through the existing log relay, so **Download Logs** picks them up: a per-response tally of how many were seen, matched, parsed, and forwarded, plus one line per captured response naming the body's top-level keys — which is what `background.js` routes on, so a shape mismatch (`items` for StubHub, `listings` for SeatGeek and TickPick) is visible rather than inferred.

When nothing matches, the log also ranks the largest JSON responses the page did fetch. That answers "then which endpoint should we be matching?" on the first run, rather than requiring the `DISCOVERY_SITE` constant to be edited and the page reloaded a second time. The recording stops as soon as anything matches, so it costs nothing once a site works.

### Cross-Site Seat Tiers

Ported the venue tiering from the TicketPortal ticketboard so marketplace listings can be grouped and compared the way FIFA listings already are.

The FIFA sites carry a real `category` (CAT 1/2/3/4). The five marketplace adapters do not — each stamps a constant (`"resale"`, `"primary"`, `"standard"`), which made the popup's category breakdown a single meaningless bucket on those sites. `tiers.js` derives a seating tier from the section text instead, so a Ticketmaster "Section 315" and a StubHub "315" land in the same band.

It resolves in three steps: a saved whole-section rule for the venue, then a row-band rule whose range contains the row, then the `tierOf()` section-text heuristic. `venue-tiers.js` holds the saved rules as a build-time export — the two repos are separate Supabase projects, so there is no live read — and it currently ships aliases only, meaning every listing takes the heuristic path for now. Row bands rank both letter rows (A–Z, then AA behind Z) and numeric rows.

The tier lands in a **parallel `tier` field**; `category` is never overwritten, so nothing that reads FIFA categories changes. CSV export gains a `Tier` column, derived at export time for seats scanned before this shipped.

Venue aliases fold FIFA's tournament names onto the sponsored names marketplaces use ("Dallas Stadium" → "at&t stadium"). These were seeded by hand and are flagged in-file as unverified against live venue strings.

### Venue: Bryant-Denny

`Bryant Denny Stadium`, as StubHub writes it, reached none of the 147 sections curated in TicketPortal under `saban field at bryant-denny stadium`. The hyphen and the "Saban Field at" prefix defeat both the alias table and base-name matching, so it fell to the section heuristic. Added as a verified alias, along with the hyphenated spelling.

### Build Stamp

Three separate debugging rounds in this project were spent analysing results produced by an extension that had not been reloaded. A stale build and a change that did not work look identical from a log, and the only way to tell them apart was to notice a line number had not moved.

`tools/package.py` now writes a short hash of the shipped sources into `injected.js`, and every page logs it:

```
[FIFA Ticket Scout] Running on StubHub (passive capture) build 06a95c3c
```

The build prints the same value, so the question is answered by comparison rather than inference. The hash is taken with the stamp line itself blanked out, so unchanged content keeps the same stamp instead of the value chasing its own tail — verified stable across three consecutive rebuilds.

### Fix: Popup Froze After About a Dozen Events

`enforceGameLimit()` only bounded storage for free users; licensed ones kept every event they had ever opened. Each capture rewrites the whole `games` object, and a single StubHub sweep produces a dozen or more captures — so by roughly the thirteenth event the extension was serialising megabytes of seat data on every response and locking up. `chrome.storage.local` is a 10MB quota without the `unlimitedStorage` permission, which this extension does not request.

Licensed users now keep the eight most recently scanned events; older ones are evicted, and the eviction is logged. The event being written always survives. Free-tier behaviour is unchanged.

### Fix: "Extension context invalidated" Spam

Reloading the extension leaves the OLD content script running in every tab that was already open, with a dead `chrome.runtime` behind it. Every relay call then threw `Extension context invalidated` — unhandled, once per captured response, from inside a listener the page's own fetch chain runs through.

There is nothing to recover: the script is orphaned until the tab reloads. It now checks for a live context, goes quiet, and says so once, telling you to refresh. Every `chrome.runtime` and `chrome.storage` call in the relay goes through that check.

The guard sits at the top of the file because the seat-preselect bridge runs at `document_start` and calls it: `let` is not hoisted, so declaring it further down would have been a temporal-dead-zone error on exactly the pages that use preselect.

### Fix: StubHub Batches Returned a Shape Nobody Read

The batch sweep worked on its first live run and was thrown away by the code that received it. Asked for ten listing ids, StubHub answered:

```
array(10 of {id, eventId, section:"833", sectionId, sectionMapName, sectionType, row:"25", seat:"19_20", …})
```

A BARE ARRAY of listing objects — where the page's own request answers with `{items:[...]}`. Both `listingsOf()` in the sweep and the routing in `background.js` read only `items`, so ten real listings counted as zero, the sweep stopped on its first batch, and the diagnostic reported the endpoint as refusing to answer. It had answered.

Both now accept either shape. The diagnostic that caught this is the same one added the round before, which printed the array it was ignoring.

The sweep also feeds itself. Every batch response carries listing ids of its own, so ids discovered along the way are queued and swept too — which is what reaches listings in sections the page never requested. On a live event the first response held ids for 280 listings out of 534 reported; the queue keeps going from there, stopping when it runs dry, when a batch fails, when three consecutive batches are all duplicates, or at the batch cap. If it stops with ids still queued it says how many.

Batches also got bigger. The page asks ten at a time, but the endpoint takes a list: 351 ids is 36 round trips at ten and 15 at twenty-five, and fewer requests is gentler on a protected endpoint. If a larger batch comes back empty on the first try, it retries once at exactly the size the page itself uses before concluding anything — the endpoint may simply cap how many ids it accepts.

### StubHub: Batch Diagnostics

A batch that comes back with no listings now names the response shape before stopping. An accepted-but-empty reply and a rejected request are indistinguishable otherwise, and they point at different fixes.

A batch of pure duplicates no longer aborts the sweep either: real listings that were already captured are not a failure, so it continues and gives up only after three consecutive duplicate batches.

### StubHub: Fetch the Rest of the Inventory

StubHub answers with a FILTERED subset: the query string on its inventory request carries sections, rows and quantity, so one capture is a slice of the event. Everything did arrive eventually, because `background.js` merges each capture into the stored seats — but only as fast as someone clicked around the page, which is not a usable way to see an event.

**The endpoint is a detail fetch, not an inventory fetch.** A live request is:

```
POST /<slug>/event/160067961/?quantity=2
{Method, EventId, Quantity, EstimatedFees, InstantDelivery, ListingIds}
```

`ListingIds` is the point: the page already holds all 591 listings and asks for ten at a time as you scroll, which is exactly why clicking around slowly fills the dashboard. So the field to remove is `ListingIds`, not `Quantity` — removing Quantity returned zero listings, and stripping the query string returned an HTML page rather than JSON. Both were measured, not guessed.

All three body variants were then measured against a live event and all three returned zero listings: the endpoint refuses to answer without `ListingIds`. It cannot be widened.

So the approach inverted. Hovering a section makes the page request that section's listings, and they appear in the dashboard — which means the page already holds every listing id and hands them over ten at a time. The ids are now harvested out of the response and requested in batches, doing programmatically what the hovering does by hand.

Ids are matched by key name rather than a fixed path, since they may sit under `ListingIds`, `listingIds`, or as `id` on objects inside a listings array — and `venueConfigId` and the ids of listings already captured are excluded. Batches use the same size the page itself asked for, capped at 30, so a large event cannot become hundreds of requests at a protected endpoint. The sweep stops as soon as a batch adds nothing new or one fails.

If the response turns out to carry no ids beyond the ten already captured, that is stated plainly: the full set lives in the page's own state rather than in any response, and reading it needs a different approach. The body variants remain as a fallback, and StubHub keeps ranking every response it sees.

Alongside this, every StubHub response now has its top-level arrays counted with its size — `items=10, sections=42, seats=591` — so a full set hiding under a key nobody reads is visible rather than inferred.

The filters ride in the POST body, not the query string. A live response echoes the request back as `{items, quantity, isInitialQuantityChange, sortBy, sections, venueConfigId, sectionIds, seats, …}`, so broadening by editing query parameters could never have worked. The request itself — method, url and body — is now remembered alongside the headers, and the first strategy re-posts it with the filter fields removed: sections, rows, zones, price bounds, and `quantity`, which narrows to listings seating exactly that many and is the main reason a first load shows a slice. `venueConfigId` and `sortBy` are left alone; they identify or order the event rather than narrow it.

Query-string strategies remain for sites that filter that way: drop the filter parameters, widen a page-size parameter, then walk page indexes until a response adds nothing new. All stop as soon as the reported total is reached.

The request is now logged in full — method, path, query string and body field names. `noteCapture()` strips the query for brevity, which had hidden exactly the evidence needed here. And `followUpDone` is set only once the request has been parsed: setting it earlier meant an early return disabled follow-up for the whole page while logging nothing, which is indistinguishable from the code never running.

It runs in the page's own context with the headers the page itself sent, so it is that request repeated rather than a forged one. That matters — this endpoint sits behind Talos and DataDome, and building a request from scratch is precisely what the adapters were written to avoid.

Totals are discovered rather than assumed: the largest number under a total-looking key at any depth, explicitly ignoring `per_page`, `page_size` and `total_pages`, which look like totals and are not counts of listings. New listings are tracked by id (`id` or `listingId`) so a broadened response that repeats what was already captured counts as adding nothing and stops the walk.

Bounded in every direction: one pass per event, ten follow-ups at most, a stop at the reported total, and a stop when a response adds no new ids. If nothing is recognised in the query string it says so and does nothing, leaving the click-to-populate behaviour underneath.

Only sites that need this are listed. SeatGeek returns its full set on the first request, so it is deliberately absent — extra requests to a bot-protected endpoint for no gain is a bad trade.

### AXS: Site Integration (No Parser Yet)

AXS is wired through every layer the other sites use — host permissions and content scripts, `axs-adapter.js` for event identity, site discrimination in both the popup and the service worker, brand, labels, CSV filename tag, fee entries, passive-capture empty state, and the reload-instead-of-scan path.

**It does not yet produce seats.** Inventing field names for a payload nobody has seen is exactly how the Evenue integration lost several rounds, so `background.js` reports the path, size and shape of whatever arrives, five levels deep and once per distinct shape, and the parser follows from that.

Capture targets `/veritix/` — AXS's ticketing engine. Its `start-flow/v1` response is the largest JSON the ticket page fetches (611KB on a live T-Mobile Center event), on the same opaque event token as the page url. The first guess at `/api/` matched only skins, tokens and map-viewer cookie checks: `/veritix/` does not contain `/api/`, so the inventory was never captured. The 1.2MB payload from `3ddvapis.com` is deliberately not matched — that is seat-map geometry, not inventory.

AXS stays flagged as unconfirmed, so the candidate ranking keeps listing everything the page fetched even now that something matches. Narrowing the pattern cannot hide a wrong guess.

Capture is passive, like SeatGeek and StubHub. AXS fronts its purchase flow with a queue and bot protection, so issuing our own inventory request would mean forging session state.

AXS has two url shapes and the buying flow uses the second one. Browse pages carry the id in the path (`www.axs.com/events/1234567/slug`), but the ticket flow runs on **tix.axs.com**, where the path is an opaque encoded blob and the event id is the `e` query param:

```
tix.axs.com/nZA9NwAAAAABIj1H…?c=axs&e=92678159754876303&rt=AfterEvent
```

Confirmed against a live T-Mobile Center event. `e` is a one-letter parameter name, so it is only accepted with 6+ digits — enough that a pagination or flag value cannot be mistaken for an event id. The adapter and the popup each implement this, as they do for every site, and both were checked against the same urls to confirm they agree, including the cases that must NOT resolve.

### Fix: The Capture Summary Repeated Forever

The summary fired after 12 seconds, cleared its timer, and the next response scheduled another — so on a ticket page, which polls and beacons continuously, it repeated every 12 seconds for as long as the tab stayed open. Making unconfirmed sites reprint the full candidate ranking each time turned that from noise into a flood: seven identical ten-line rankings in one session.

It now reports twice at most — once early enough to be useful, once more only if the page kept loading things worth seeing — and skips the second when nothing has changed since the first. The final line is marked as such. Counting continues either way, and every captured response still logs its own line.

### Fix: A Match on Noise Suppressed the Endpoint Report

Candidate recording stopped as soon as `MATCH_PATTERNS` hit anything. That is right once a site works, but on AXS the deliberately broad `/api/` matched eight skin, token and cookie-check responses from the 3D Digital Venue map viewer — none of them inventory — and that was enough to suppress the report that would have named the real endpoint. The first AXS load produced no ranking at all.

Sites whose endpoint is still unconfirmed now keep recording regardless of what matched, and rank everything the page fetched rather than only the unmatched remainder. A match means nothing until a parser exists to act on it.

### Refactor: One Passive-Site Table

`showEmpty()` took seven positional booleans and was about to take an eighth, with four near-identical branches differing only in a site's name. It now takes a single `detected` object, and the passive sites share one branch driven by `PASSIVE_SITE_LABELS` — the single list of which sites are passive, also read by the reload-instead-of-scan path. Adding a site is now one entry rather than four parallel edits and a positional argument nobody can read.

### Import Categories From the Popup

An **Import Categories** button in the actions row takes the same CSV the build script does, so a venue can be mapped without touching the repo or rebuilding the extension. Below it, a line reports what is currently imported — sections, venues, row bands, and the venue names — with a **Remove** control that restores the built-in mapping.

`extension/venue-import.js` is a JS mirror of the build script's CSV reader, deliberately duplicated rather than shared: the two run in different languages, and a file that imports in the app but fails at build time (or the reverse) would be worse than the duplication. It handles quoted fields, so a spreadsheet export with a comma in a venue or category name works. A file is refused whole on any problem, with up to six line-numbered reasons shown, rather than half-applied.

Imported rows are stored raw in `chrome.storage.local` and layered over the shipped `venue-tiers.js` at runtime; the shipped file is never written to. So rebuilding it from the TicketPortal export cannot clobber an import, and removing an import restores it exactly. The overlay is applied in the service worker as well as the popup, so the `tier` stamped onto seats at scan time agrees with what is rendered, and a `chrome.storage.onChanged` listener re-applies it without waiting for a worker restart.

Venue names in an import are resolved through `venueKey()`, the same path a live page's venue takes. A hand-written `Memorial Stadium` lands on the shipped `memorial stadium - ne` rather than creating a second venue that would then shadow 122 curated sections on an exact-match lookup. An imported venue and section REPLACES the shipped rules for that section rather than adding to them, so a correction fixes the mapping instead of stacking a second rule beside the wrong one.

### Import Venue Categories From a CSV

The only way in was the TicketPortal SQL export, which is no help for a venue TicketPortal does not track or for a mapping that needs correcting by hand. `tools/venue_categories.csv` is now a second source, merged on top of the export every build, so an entry there beats the database and survives re-running the export.

```
python tools/build_venue_tiers.py --import my_venue.csv
python tools/build_venue_tiers.py
```

`tools/venue_categories.sample.csv` documents the format and is itself importable. Columns are `venue, section, row_from, row_to, tier, sort`: leave both row columns blank for a whole section, fill them for an inclusive row band, leave `section` blank to set a category's tab position without mapping anything. Column order follows the header row, so optional columns can be reordered or dropped.

Importing a venue+section REPLACES whatever was held for that section rather than adding to it, so re-importing a corrected file fixes a wrong mapping instead of stacking a second one beside it. Sections not mentioned are left alone.

A file is validated whole and refused whole — a silently dropped row is worse than a failed import. The checks are the ones `tests/tiers.test.js` runs against the generated file, moved to where the error can name a line number: two catch-all rules on one section, numeric and lettered row bands mixed in one section, a band running backwards, an unrankable row bound, one category claiming two sort positions, missing venue or tier, and an unparseable sort.

Venue names are resolved the way `tiers.js` resolves them at runtime, including the base-name step. A hand-written `Memorial Stadium` lands on the export's `memorial stadium - ne` rather than creating a second venue beside it — which would have shadowed 122 curated sections with whatever few the CSV held, since the shorter name wins an exact-match lookup. An ambiguous base is left alone and reported rather than guessed.

The TicketPortal export is no longer required. With a category CSV present the build runs from that alone, and with neither it says how to produce either one.

### Export Pipeline for Custom Tiers

The custom per-venue mappings live in TicketPortal's `venue_aliases`, `venue_tiers`, and `venue_sections` tables. An anon read of those returns HTTP 200 with zero rows — RLS filters them, which the `created_by` column and the app's login gate both imply — so there is no live path from this repo, and pulling them needs credentials this build should not hold.

Instead there is a repeatable export:

1. `tools/export_venue_tiers.sql` — run in the **TicketPortal** project's SQL editor, where service_role bypasses RLS. Returns one JSON cell holding all three tables in `VENUE_TIER_DATA` shape.
2. Save that cell to `tools/venue_tiers_export.json` (gitignored — it is a data dump from another project).
3. `python tools/build_venue_tiers.py` regenerates `extension/venue-tiers.js`.

The generator re-normalizes section keys through a Python mirror of `normSec()`, so whatever casing TicketPortal stored lines up with what `tierFor()` looks up — `"Section 101"` becomes `"101"`. It folds venue names through `normVenue()`, merges aliased venues (deduping tiers on name, keeping the lowest sort), drops rules with no tier and sections that normalize to an empty key, and sorts everything for a stable diff. `--stats` prints per-venue rule counts without writing; `--only <venue>` limits output, since TicketPortal tracks venues well beyond the sixteen World Cup stadiums and each unused one is dead weight in the shipped extension.

Curated FIFA venue aliases moved to `tools/fifa_venue_aliases.json` so regenerating never drops them, split into `verified` and `unverified` groups. They are merged on top of the database aliases, so a hand fix beats a stale row.

### First Real Export

The TicketPortal export landed: **22 venues, 1584 sections, 1623 rules, 75 row bands.**

Exactly one is a World Cup venue — **Arrowhead Stadium**, with 149 hand-curated sections (`Cat A - LL Chiefs Center 3`, `Cat F - LL Endzone`, `Cat J - Club Endzone`). The other 21 are college football stadiums, Sphere, and theatres. They still earn their place: the Ticketmaster, StubHub, SeatGeek, TickPick, and Evenue adapters are not FIFA-restricted, so tiering works on any event at those venues. Shipping all 22 costs 130 KB; `--only "arrowhead stadium"` cuts it to 14 KB if that trade stops being worth it.

Row bands are exercised by exactly one venue, Michigan Stadium, which holds all 75.

**A generator bug, caught by the structural validators rather than in production.** TicketPortal holds the same building twice: `arrowhead stadium` with the curated tiers, and `geha field at arrowhead stadium` with 23 sections of auto-seeded `tierOf()` defaults (`Lower (100s)`, `Club / Mezz (200s)`). The curated alias folds them onto one key, and the first version of the merge concatenated rather than resolved — stacking two catch-all rules on all 23 shared sections, with `tierFor()` taking whichever landed first. Every one of the 23 conflicted, so the auto-seeded default could beat the curated tier.

The merge now resolves: the canonical venue's own rows win, an aliased venue only fills sections the canonical one leaves undefined, and skipped duplicates are reported by source venue. Primary is picked by name match, then by richest mapping, then alphabetically, so runs are reproducible.

Worth fixing upstream: four more venue pairs show the same split without aliases to fold them — `bobby dodd stadium` / `bobby dodd stadium atlanta, ga`, and the same shape for `bridgeforth`, `lane`, and `neyland`. Neither side is curated yet, so nothing is lost today, but aliasing them in TicketPortal would consolidate the mappings.

### Fixes From First Live Use

Three things surfaced testing against a real Arrowhead Stadium event.

**Stored tiers went stale and shadowed the fix.** The popup read `s.tier` and only computed a tier when that was absent. But `tier` is stamped at scan time, while `venue-tiers.js` ships with the extension and changes on release — so seats scanned before a mapping landed kept a stale `Upper (300s)` forever, and the corrected lookup never ran. Symptom: the toggle correctly reported `arrowhead stadium · 149 mapped sections` while the tabs still showed generic heuristic bands. The tier is now always recomputed at render and export time; `normSec` and `venueKey` are both memoized, so the cost is negligible. Background still stamps `tier` on the Supabase payload, where a point-in-time snapshot is what you want.

**Venue names carry city suffixes.** `event-info.js` reads the venue from JSON-LD `location.name`, and marketplaces write `"Arrowhead Stadium, Kansas City, MO"` or append the city with no separator at all — the same shape as `bobby dodd stadium atlanta, ga` in TicketPortal's own rows. An exact lookup misses those silently. `venueKey()` now tries the exact name, then drops trailing comma-separated fragments, then longest-prefix-matches against known venue keys, requiring a word boundary so one venue cannot swallow another. Results are memoized, and the cache invalidates on `VENUE_TIER_DATA` identity so a swapped dataset cannot serve stale keys.

**The heuristic fallback was invisible.** A curated mapping and the section-text heuristic both produce plausible tier names, so a venue mismatch read as working. The Group by toggle now names the matched venue and its section count, or flags `unmapped · heuristic` in Tier mode, and `background.js` logs one `[tiers]` line per scan naming the venue, the key it resolved to, and whether a mapping was found.

Arrowhead resolves to 149 sections — 123 numeric bowl sections plus parking, suites and club areas — across 17 tiers, 14 of them the curated `Cat A - LL Chiefs Center 3` through `Cat N - Upper Endzone`.

### Test Harness

`tests/tiers.test.js` covers the port against the TicketPortal originals — 47 assertions over the heuristic, row-band resolution, alias folding, and ordering.

There is no node on the machines this was built on, so `tests/run.py` drives the suite through headless Chrome instead, which is the browser the extension targets anyway. `tests/runner.html` loads the real `venue-tiers.js` and `tiers.js` in load order and the test file writes a `TIERS-RESULT` marker the runner greps out of the dumped DOM; the runner exits non-zero on failure. The test file detects its host, so `node tests/tiers.test.js` also works wherever node is available.

The suite is in three phases: pure functions, structural validation of the generated `venue-tiers.js`, and resolution against a controlled fixture that replaces the shipped data — so a new export can never break the resolution tests.

Phase two is the one that earns its keep. It catches classes of bad data that would otherwise fail silently at runtime: an alias pointing at another alias (`venueKey()` does one hop, so a chain resolves to the wrong venue), a `tiers`/`sections` key that is itself aliased away so nothing ever looks it up, a section key that is not `normSec`-normalized and therefore unreachable, a section mixing numeric and lettered row bands where `rowRank` makes "row 5 vs row E" a coin flip, and a section with two catch-all rules. All of them pass on an empty file, so they held before the first export and keep holding after.

`tests/syntax.html` parse-checks all twelve extension scripts before the unit tests run, because a parse error in `background.js` stops the service worker from starting and one in `popup.js` leaves the popup blank — both look exactly like "my changes did not apply", and neither is visible until the extension is loaded in Chrome. `tests/run.py` runs it first and stops there if it fails.

Verified in both directions: 68/68 green, and three deliberate corruptions — an alias chain, an unnormalized section key, and mixed band types — each produced a named failure and a non-zero exit. Breaking one branch of `tierOf()` produced three failures across all three of its call paths.

### Group By: Category or Tier

A **Group by** switch above the category tabs flips the whole panel — tabs, price histogram, and cheapest clusters — between the site's own category and the seat tier. Each side shows how many buckets it would split into.

The default is per site rather than fixed: when a site reports fewer than two distinct categories, Tier is selected and a short note says why, because Category would otherwise render one tab covering everything. FIFA, with real CAT 1/2/3/4, still opens on Category. An explicit choice wins and persists alongside the existing filters.

Tabs sort alphabetically in both modes, so a tab sits where you expect rather than moving as seat counts shift. The comparator (`tierNameCmp`) sorts on the ABBREVIATED name, which is what keeps a row-split family together: Michigan Stadium names its splits `Cat A` / `Cat A1` / `Cat A2` with different descriptions after the `" - "`, and sorting full strings would let those descriptions interleave the family. Collation is numeric, so `Category 2` precedes `Category 10` and `Upper (300s)` precedes `Upper (400+)`.

One consequence worth knowing: this replaces the stadium-inward ordering, so the per-venue `sort` column from TicketPortal's `venue_tiers` no longer drives tab order. `tierRank()` is still there and still tested, just unused by the tab strip.

Long tier names abbreviate to their `Cat A` prefix with the full name on hover. Switching modes resets the active tab to All, since the two produce different bucket counts. The category dot only keeps its colour when every seat in a bucket agrees on it — a tier can span several FIFA categories.

**Files changed:** `extension/tiers.js` (new), `extension/venue-tiers.js` (new, generated), `tools/export_venue_tiers.sql` (new), `tools/build_venue_tiers.py` (new), `tools/fifa_venue_aliases.json` (new), `tests/tiers.test.js` (new), `tests/runner.html` (new), `tests/run.py` (new), `.gitignore`, `extension/background.js`, `extension/popup.js`, `extension/popup.html`, `extension/popup.css`

---

## August 13, 2026 — v2.3.5

### Fix: Ticketmaster Seats Imported Without Prices

Ticketmaster seats were landing in the dashboard with no price. Price resolution read only `_embedded.offer`, probing a list of guessed field spellings (`totalPrice`, `faceValue`, `listPrice`, …) because the real field name had never been confirmed against a live response.

A capture of event `0700646BCF6088AD` settled it: price is carried on the facet itself as `listPriceRange`, an array of `{ currency, min, max }` in whole dollars (`371.00`), not cents. A facet groups identically-priced listings, so `min` and `max` are normally equal and we take `min`, preferring the USD entry when an event lists multiple currencies. The `_embedded.offer` probe is kept as a fallback for responses that omit `listPriceRange`.

The offer ids themselves are opaque routing handles — `GN6DCMRVGAYDOOBRGIZHYMJZHAZDCODBGQ2DK` decodes to `3|1250078122|198218a445` — so they were never going to yield a price on their own.

Stored as `dollars * 1000` to match `centsToUSD()` in the popup, which applies a `1.0` fee multiplier for the `ticketmaster` site, so listed prices render through unchanged.

**Files changed:** `extension/background.js`

### Ticketmaster Support

Added Ticketmaster as a second source alongside the FIFA resale site. A new adapter (`ticketmaster-adapter.js`) detects event pages, pulls the event id from the URL and the `c-tmpt` token from cookies, and calls the ISMDS facets endpoint. `injected.js` routes Ticketmaster scans to the adapter and posts the raw response through to the service worker, which does the parsing.

Decoding seats out of a facets response takes two passes. Seats arrive packed into a `places` string under `compress=places`, first as nested bracket groups — `A[B,C]` is `AB` and `AC`, nesting arbitrarily — and each expanded id is then unpadded RFC 4648 base32 over `<section>:<row>:<seat>`, so `GEYDAORTGE5DEMY` decodes to section 100, row 31, seat 23. Verified against a live response: every facet's expanded place count matched its reported `count`.

Two request-parameter details cost real debugging time. `embed` repeats once per value — passing an array to the `URLSearchParams` constructor stringifies it to `area,description`, which the API rejects. And `embed=offer` is what makes prices resolvable at all; without it the response still lists every seat, but each facet references only an opaque offer id.

Site discrimination runs off the hostname (`siteFromUrl`), seats are namespaced under a `ticketmaster:<eventId>` game key, and the popup gained a Ticketmaster empty state plus a `1.0` fee multiplier (its listed prices are already all-in, unlike the FIFA resale site's `1.15`).

**Files changed:** `extension/manifest.json`, `extension/ticketmaster-adapter.js`, `extension/injected.js`, `extension/content.js`, `extension/background.js`, `extension/popup.js`, `extension/popup.html`, `extension/popup.css`

---

## April 20, 2026 — v2.3.4

### Per-License Alert Pick Overrides

Added server-side per-license `maxPicks` overrides so individual users can have a higher pick limit (upon additional purchases) without affecting everyone. The override map lives in `alert_constants.ts`; adding a new entry requires an edge function redeploy. The popup now reads the server-returned `maxPicks` from the `get-alerts` response, so overridden users see the correct slot count in the UI automatically.

**Redeploy:** `supabase functions deploy save-alerts` and `supabase functions deploy get-alerts`

**Files changed:** `supabase/functions/_shared/alert_constants.ts`, `supabase/functions/save-alerts/index.ts`, `supabase/functions/get-alerts/index.ts`, `extension/popup.js`, `extension/manifest.json`

---

## April 19, 2026 — v2.3.3

### Allow Swapping Alert Game Picks + Increase to 6 Picks

Alert picks are no longer permanently locked after saving. Users can now remove a saved match and add a different one. Pick limit raised from 3 to 6. The email lock remains in place. Removed all per-pick lock enforcement from the backend (`save-alerts`) and lock UI from the frontend (lock icons, "picks are final" warning, confirmation dialog).

**Note:** Also update `max_picks` to `6` in `scan_config.json` in the public repo.

**Files changed:** `extension/popup.js`, `extension/background.js`, `supabase/functions/save-alerts/index.ts`, `supabase/functions/get-alerts/index.ts`

---

## April 19, 2026 — v2.3.2

### Fix: Insights Tab Rejecting Pro + Web Licenses

The `get-insights` Edge Function was hardcoded to verify against the Pro + Web + Alerts product ID (level 30), so Pro + Web users (level 20) passed the client-side check but got "License not valid for Insights tier" from the server. Fixed to accept any license level 20+.

### Remote Max Alerts Control

The per-user alert pick limit (`maxPicks`) is now read from `scan_config.json` in the public GitHub repo instead of being hardcoded server-side. To change the limit, edit `max_picks` in `scan_config.json` and push — no Edge Function redeploy or extension update needed. Server-side `MAX_PICKS` raised to 10 as a safety ceiling only.

**Files changed:** `supabase/functions/get-insights/index.ts`, `supabase/functions/_shared/alert_constants.ts`, `extension/popup.js`, `extension/manifest.json`

---

## April 18, 2026 — v2.3.1

### Fix: Map Zoom Triggering DataDome Block

Zooming the seatmap after a scan could trigger a duplicate full scan, causing DataDome to restrict access. Root cause: the `scannedGames` deduplication guard was an in-memory `Set` that was lost when the MV3 service worker terminated after idle (~30s). When the site's own `/seatmap/config` request fired on zoom, the restarted worker treated it as a fresh page and re-scanned.

**Fix:** Persisted `scannedGames` in `chrome.storage.session` (survives SW restarts, clears on browser close). Added defense-in-depth `scanInProgress` flag and 60-second cooldown in `injected.js` to reject duplicate scan commands at the page level. Manual rescans from the popup bypass the cooldown via a `force` flag.

**Files changed:** `extension/background.js`, `extension/injected.js`, `extension/content.js`, `extension/manifest.json`

---

## April 18, 2026 — v2.3.0

### Insights Tab — Market Insights with Two Chart Types

Replaced the "Coming Soon" placeholder with a fully functional Insights tab, powered by a Supabase materialized table (`insights_priced_to_sell`) that refreshes hourly via `pg_cron`.

**Avg "Priced to Sell" (bar chart):** Shows the average price of the cheapest 15% of listings per day over 7 days. Represents what motivated sellers are actually asking. Day-over-day percentage change displayed above each bar. Color gradient dampened so narrow price ranges don't appear misleadingly different.

**Wall Movement (heatmap):** Price distribution grid — days as columns, price ranges as rows. Cell intensity shows what percentage of that day's listings sit in each price bucket. Dark bands = price walls where sellers cluster. Bands drifting down = sellers capitulating. Dynamic bucketing collapses the top 20% (P80+) and mid-range (P50–P80) into single rows, with granular rows in the bottom 50% where walls are most visible. Royal blue color scale with adaptive text color (white on dark, gray on light).

**Filters:** Four multi-select checkbox dropdowns (game, city, team, category) with cascading logic — selecting a city narrows the available games/teams/categories, and vice versa. LMS toggle ("Include Last Minute Sales site") off by default. Knockout games show stage + matchup code in dropdown (e.g. "#73 · R32 · 2A v 2B").

**Info button:** (i) next to "Market Insights" toggles an explanation panel describing the current chart type and noting data is crowdsourced from the community.

**"Current" column:** Rightmost column labeled "Current / Earlier Today" shows data from today's scans, refreshed hourly.

**License gating:** Insights requires Pro + Web tier (level 20), lowered from Pro + Web + Alerts (30). Locked state shows faded preview screenshot background with license key input form — users can activate without switching to the Scanner tab. Same license input added to Alerts locked state.

**Scan-ago timer:** Small "7 mins ago" label under the SCANNED badge, persisted in `chrome.storage.local` so it survives popup close/reopen. Updates every 60 seconds.

**SQL architecture:** Two-phase refresh function — Phase 1 computes bottom-15% avg per (match, day, category), Phase 2 backfills price histograms ($50 buckets) from all seats. Uses `ROW_NUMBER()` top-5 scans per day with downstream NULL-price filtering (avoids expensive EXISTS checks). Staging table swap for zero-downtime refreshes. JOINs `match_schedule` for proper game info and `category_xref` for normalized category names (Cat 1–4, Accessible, Other).

**Edge function (`get-insights`):** Paginated fetch (1000-row batches) to bypass Supabase `max_rows` cap. Pro + Web license verification via Gumroad API.

**Files changed:** `extension/popup.js`, `extension/popup.css`, `extension/popup.html`, `extension/background.js`, `supabase/functions/get-insights/index.ts`
**Files added:** `extension/images/insights-preview.png`, `extension/images/alerts-preview.png`
**Local-only (not in repo):** `supabase/migrate_insights.sql`, `supabase/seed_category_xref.sql`

---

## April 17, 2026

### Remote Scan Config — DB-Controlled Timing Profiles

Scan timing constants (jitter delays, retry cooldowns, consecutive-block thresholds, speed profiles) are no longer hardcoded in `injected.js`. They now live in a `scan_config` Supabase table and are fetched on extension startup + every 60 minutes via `chrome.alarms`. The extension falls back to hardcoded defaults if the fetch fails (offline resilience).

Also corrected the speed profile ordering — "cautious" was previously faster than "balanced" (500-900ms vs 900-1500ms). New corrected values: aggressive (0-0ms), balanced (600-1000ms), cautious (1200-1800ms), stealth (1300-2700ms).

To tune live: `UPDATE scan_config SET profiles = jsonb_set(profiles, '{balanced}', '{"min":500,"max":800}') WHERE id = 1;` via Supabase SQL editor. No extension update needed.

**Files changed:** `extension/background.js`, `extension/content.js`, `extension/injected.js`, `supabase/schema.sql`
**Files added:** `supabase/migrate_scan_config.sql`

### LMS (Last Minute Sales) Site Support — v2.2.0

Added full support for FIFA's Last Minute Sales site (`fwc26-shop-usd.tickets.fifa.com`), where FIFA drops face-value tickets. The extension now works on both the resale and LMS sites with the same scan, display, and sync pipeline.

**How it works:** Site is derived from the hostname (`-shop-` = LMS, `-resale-` = resale) when API responses arrive in `background.js`. All game storage uses a compound `site:performanceId` key so LMS and resale data for the same match coexist without collision. LMS and resale share the same `performanceId` for a given match, so compound keys are mandatory.

**Pricing:** Resale seats carry per-seat `amount` (formula: `÷1000 × 1.15`). LMS seats get their price from `seatBasedPriceAmount` (premium/front-row overrides) or from the category-level pricing in the availability endpoint (formula: `÷1000`, no markup — face value). `saveAvailability` backfills any seats that arrived before category data was available.

**Popup:** Site badge (green "LMS" / purple "Resale") next to match name. `centsToUSD` is site-aware (1.15× resale, 1.0× LMS). Empty state shows buttons for both sites. Histogram shows full distribution for LMS (no top-20% tail cutoff) with single-price categories rendered as one bar flanked by empty buckets. Sort tiebreaker added: block → row → seat when prices are equal. CSV export includes `Site` in metadata.

**Database:** `site` column added to `scan_snapshots`, `seats`, `match_summary`, `match_summary_history`. Primary keys on `seats` and `match_summary` changed to compound `(site, performance_id, ...)`. Migration file: `supabase/migrate_add_site.sql`. Existing rows defaulted to `'resale'`.

**Ingest:** `ingest-scan` accepts `site` in payload, scopes all deletes and stats recomputes by `(site, performance_id)`. Zero-seat LMS scans log a snapshot row with `seat_count=0`. Suspicious price distribution check skipped for LMS (face-value tickets legitimately share prices).

**Alerts:** Site-agnostic by design. `alert_configs` stores `performance_id` + threshold with no site field — the future dispatcher queries by `performance_id` without site filter, covering both sites.

**Startup migration:** On service worker boot, legacy bare-perfId game keys are rewritten to `resale:perfId` with `site='resale'` stamped.

**Files changed:** `extension/background.js`, `extension/popup.js`, `extension/popup.html`, `extension/popup.css`, `supabase/schema.sql`, `supabase/functions/ingest-scan/index.ts`
**Files added:** `supabase/migrate_add_site.sql`

---

## April 14, 2026

### Alerts Fix: Per-Pick Locking + Centralized MAX_PICKS + 180-Day TTL — 2:30 AM ET
Fixed the "saved 1 pick, can't add the other 2" bug reported by a Pro + Web + Alerts user. The original lock was per-config (`games_locked` flag at the whole-form level), so saving with any count N < 3 hid the match browser entirely and there was no way to top off the remaining slots. Lock is now **per-pick**: saved matches remain permanent individually (lock icon + threshold-only edit drawer), but the browse section and empty pick slots stay visible whenever total picks < `MAX_PICKS`. New picks added in a later session trigger the same confirm dialog as the original first save and lock once committed. Server-side enforcement added in `save-alerts`: fetches the existing games array on update, rejects any request that drops a locked match or swaps its `performance_id`. Unsaved picks in the current session can still be freely removed via the drawer's "Remove pick" button, which only renders for unlocked picks.

Also centralized the `MAX_PICKS = 3` constant into a new `supabase/functions/_shared/alert_constants.ts` module, imported by both `save-alerts` and `get-alerts`. Both Edge Functions return it as `maxPicks` in their JSON response; the popup reads from there and drives every former literal `3` off it (slot iteration, counter, subtitle, browser visibility check, add-button guard). Changing the per-user pick limit is now one constant edit + `supabase functions deploy` for both functions — the popup auto-syncs on next `loadSavedAlertConfig()` call with zero client rebuild.

Added an `expires_at` column to `alert_configs` with a 180-day SQL default. Set on insert via the column default, never touched on update — adding picks later does not roll the TTL forward. Returned as `expiresAt` (ms epoch) from `get-alerts` for future UI use; popup ignores it for now. Live migration + backfill for existing rows (`expires_at = created_at + interval '180 days'`) ran by hand in the Supabase SQL Editor.

**Files changed:** `extension/popup.js`, `supabase/functions/save-alerts/index.ts`, `supabase/functions/get-alerts/index.ts`, `supabase/schema.sql`
**Files added:** `supabase/functions/_shared/alert_constants.ts`

### Clarify Scan State in Popup: Stuck-Help + SCANNING/SCANNED Badge — 1:10 AM ET
Two honesty fixes on the Scanner tab. First: a new "Stuck here?" help block appears on the Scanning empty state, pointing users at the BUY TICKETS → BUY → game workaround for when the seat map page doesn't kick off the API calls the extension needs to start a scan. Subtle purple accent panel under the existing hint, only visible in the Scanning variant of the empty state. Second: the header badge no longer says "LIVE" with a 1.5s pulsing green dot (which falsely implied continuous real-time monitoring). It now flips between **SCANNING** during an active scan and **SCANNED** once the scan status hits `done` or progress reaches 100%, with a static green dot — no animation. State transition reads cleanly: empty-state "Scanning…" → dashboard "SCANNING" badge → "SCANNED" on the final tile. No timer drift, no stale "LIVE" claims while the user is staring at a several-hours-old snapshot.

**Files changed:** `extension/popup.html`, `extension/popup.css`, `extension/popup.js`

### Capture Extra Seat Fields for Preselect Bridge — 1:05 AM ET
Three more fields added to the per-seat object captured in `background.js` `saveSeats`: `contingentId`, `seatQuality`, and `extent` (the seat polygon's bounding box `[minX, minY, maxX, maxY]`, computed by a new `bboxOf()` helper that walks any nested coordinate array — Point, Polygon, or MultiPolygon). These are the fields the FIFA SPA needs to render a "selected" state when the seat-preselect bridge eventually writes entries into sessionStorage. All three flow through to `scan_snapshots.seats_data` JSONB automatically — no DB schema change, no `ingest-scan` change. The bridge itself remains paused on the blocker of not knowing the live SPA's sessionStorage key yet; this change just gets the data flowing so when the bridge is unblocked, real scan data is already populated in the cloud for testing and field-diffing against hand-picked entries.

**Files changed:** `extension/background.js`

### Salvage Scans on Per-Seat Anomalies — 1:00 AM ET
Fixed a bug where the `ingest-scan` Edge Function would reject an entire scan (HTTP 400) if any single seat had an out-of-range price, bad `seatId`, or oversized string field. Root cause: the per-seat validation loop at [`index.ts:63-88`](supabase/functions/ingest-scan/index.ts#L63-L88) returned on the first failure instead of skipping the bad seat. New behavior: clamp prices above the Postgres int4 max to `2147483647`, null out sub-$1 or non-numeric prices (the `seats.price` column is already nullable), truncate oversized string fields to 100 chars, and drop seats with bad IDs (primary key — nothing to recover). `MIN_SEAT_COUNT` lowered from 10 to 1 so sold-out matches with only a handful of resale seats still ingest. `MAX_SEAT_COUNT` raised from 15,000 to 50,000 **and** changed from hard-reject to soft-trim — runaway payloads get sliced to the cap with a server-side `console.log` instead of bouncing the whole scan. Top-level structural checks (visitorId format, performanceId format, match name, 50%-same-price anomaly guard) still reject on fail, because those genuinely indicate a broken scan.

Originally diagnosed when David's and his brother-in-law's scans were silently not landing in `scan_snapshots` while everyone else's were. Walked the DevTools service-worker Network tab → saw a 400 on the POST → response body named `"Seat price out of range"` → root caused to a single VIP-tier seat exceeding the previous `MAX_PRICE_MILLICENTS = 100_000_000` (~$100k) cap, which rejected the entire ~10k seat payload. The new cap is the Postgres `int4` column ceiling, not an arbitrary anti-abuse number.

**Files changed:** `supabase/functions/ingest-scan/index.ts`

---

## April 13, 2026

### Cloud Restore for Alerts + "Picks Are Final" Warning — 1:00 AM ET
Added a `get-alerts` Edge Function so the extension can rehydrate the Alerts tab from Supabase whenever the local cache is missing or stale. Previously, if `chrome.storage.local.alertConfigs` was lost (extension reinstall, new browser, new machine, profile switch, Chrome Sync reset, or — until earlier today — a Clear & Rescan click), the Alerts tab would show as empty even though the dispatcher was still firing emails to the user from the server-side `alert_configs` row. Worse, re-saving with a different email would hit the email-lock 403 with no way for the user to recover. Now: every Alerts tab open does a cloud fetch first using the user's license key, falls back to local cache only on network/server failure, and shows a small "⚠ Offline — cached picks" chip in the header when running offline. Server is always the source of truth on conflict; local cache is purely an offline fallback. New `FETCH_ALERTS` message type in the background service worker, mirroring the existing `SAVE_ALERTS` structure (license verify → hash → service-role read on `alert_configs`).

Also added a prominent orange warning banner at the top of the Alerts tab (before first save only) reminding users that match picks are final after saving — only price thresholds can change later. Disappears once `gamesLocked` becomes true so it doesn't nag users who already committed.

**Files changed:** `extension/background.js`, `extension/popup.js`, `extension/popup.css`, `CHANGELOG.md`
**Files added:** `supabase/functions/get-alerts/index.ts`

### Fix: Clear & Rescan No Longer Wipes Alerts — 12:00 AM ET
The "Clear & Rescan" and "Clear Data" buttons on the Scanner tab were silently destroying the user's saved Alerts tab picks (matches, thresholds, category, seats) as a side effect. Root cause: the `CLEAR_DATA` background handler used `chrome.storage.local.clear()` and manually rescued only the `license` key, so any other top-level key (including `alertConfigs` and `visitorId`) got nuked. Replaced the clear-then-restore dance with a surgical `chrome.storage.local.remove("games")` — only the captured scan data is removed, everything else (Alerts picks, license, visitor ID, scan speed preference, filter state) is untouched. Forward-compatible: any future storage key automatically survives by default. Also fixes a silent secondary bug where `visitorId` (the anonymous Supabase attribution key) was being regenerated on every Clear & Rescan, inflating "unique scanners" stats and breaking per-user scan history correlation on the backend.

**Files changed:** `background.js`

---

## April 12, 2026

### Alerts Tab — Pro + Web + Alerts Tier — 10:00 PM ET
Added a third tab to the popup ("Alerts") for Pro + Web + Alerts ($49.99) users. Pick up to 3 World Cup matches, set a price threshold per match (3 modes: % of face value, $ offset from face, or absolute $), choose a category filter (Any / CAT 1 / CAT 2 / CAT 3) and number of seats needed. Picks are saved to Supabase via a new `save-alerts` Edge Function that verifies the Gumroad license server-side and locks the user's email + chosen matches. Threshold drawer features a custom range slider with a green "deal zone" (gradient fill that follows the thumb) and a live example that updates in real time as the user drags. Free / lower-tier users see an upgrade prompt instead of the picker. Match list is searchable + filterable by stage and country. Locked picks show as read-only after first save; only thresholds can be adjusted.

**Files changed:** `popup.js`, `popup.css`, `popup.html`, `background.js`
**Files added:** `supabase/functions/save-alerts/index.ts`

### Threshold Slider — 3-Mode Price Targeting — 9:00 PM ET
Replaced the original "Below face / Custom $" segmented control in the Alerts threshold drawer with a slider supporting three modes:
- **% vs Face** (default): -50% to +300%, snaps to 5% steps
- **$ vs Face**: -$500 to +$3000, snaps to $100 steps
- **Absolute $**: $0 to $5000, snaps to $50 steps

Slider track has a green fill that tracks the thumb, current value displayed above as a label (`+10%` / `Face` / `+$250` / `$550`), and a live example sentence using a fixed $500 reference face value for easy mental math (e.g. "If face value is $500, at +20%, you'll be alerted when the price drops at or below $600."). The Absolute mode is honest: "Ignore face value, you'll be alerted when the price drops at or below $X." Pick summary line shows the user's intent compactly: `≤+10% vFace · Any · 2tix` instead of just dollars. Threshold dollar value resolved at save time using the actual face value from the `face_values` table.

**Files changed:** `popup.js`, `popup.css`

### `alerts_sent` Audit Table + Dispatcher Dedup Hooks — 8:30 PM ET
Added an `alerts_sent` table to track every email the (forthcoming) dispatcher fires. Each row captures `license_hash`, `email`, `match_number`, `performance_id`, `threshold`, `fired_price`, `category`, and `fired_at`. Indexed on `(license_hash, match_number, fired_at DESC)` for fast dedup lookups. RLS locks it down to service-role only. Used by the dispatcher to enforce: 24-hour cooldown per `(license, match)` pair, with a re-fire allowed if the new price is at least 10% lower than the last fired price (meaningful re-drop only).

**Files changed:** `supabase/schema.sql`

### `alert_configs_history` Audit Log — 8:00 PM ET
Added an `alert_configs_history` table that captures every save against `alert_configs` (insert or update) as an immutable row. Lets us see how a user's picks evolve over time without rewriting the live `alert_configs` row. The `save-alerts` Edge Function appends to history on every successful save (best-effort — failure here doesn't fail the user's save). Indexed on `(license_hash, saved_at DESC)` and `(saved_at DESC)`. RLS service-role only.

**Files changed:** `supabase/schema.sql`, `supabase/functions/save-alerts/index.ts`

### Seat Preselect Bridge Scaffolding (Inactive — Future Feature) — 7:30 PM ET
Added the client-side scaffolding for an "email link → preselected seats" feature: when the dispatcher's alert email link includes `?fts_seats=A,B`, the extension's `content.js` content script parses the param, looks up rich seat metadata from `chrome.storage.local`, and writes to the FIFA seat picker's sessionStorage so the picker boots with those seats already highlighted. `background.js` now captures additional FIFA seat fields (`blockId`, `areaId`, `tariffId`, `advantageId`, `movementId`) per scan to support this. **Currently inactive** — the storage shape needs to be reverse-engineered against the live FIFA SPA (the legacy Secutix shape this was built against has been replaced by a newer frontend); the bridge writes to a key the SPA doesn't read, which is a silent no-op. No user-facing impact until the bridge is rewritten and the dispatcher starts emitting `?fts_seats=` URLs.

**Files changed:** `background.js`, `content.js`

### Supabase Composite Indexes + Match Schedule Performance IDs — 6:00 PM ET
Added composite indexes to `scan_snapshots` for the most common query patterns: `(performance_id, scanned_at DESC)` and `(visitor_id, scanned_at DESC)`. Backfilled `performance_id` into the `match_schedule` table so dispatcher and webapp can resolve match → performance_id without a join through `match_summary`.

**Files changed:** `supabase/schema.sql`, `supabase/seed_match_schedule.sql`

### Seats Table Reflects Current Availability — 5:00 PM ET
Changed `ingest-scan` from upsert-by-seat-id to delete-then-insert per match. Old behavior left stale rows in `seats` for seats that had since been bought — every scan would silently grow the table. Now each scan deletes all rows for that `performance_id` first and inserts the fresh set, so `seats` always reflects the current availability snapshot from the most recent scanner. `first_seen_at` is set to the same timestamp as `last_seen_at` since we no longer track historical first-sightings (use `scan_snapshots` for that).

**Files changed:** `supabase/functions/ingest-scan/index.ts`

### Match Schedule Seed (Full Country Names) — 4:00 PM ET
Added `supabase/seed_match_schedule.sql` containing all 104 World Cup 2026 matches with date, stage, city, home/away teams (full English country names like "United States" not "USA"), and `matchup` fallback for TBD knockout fixtures. Public read RLS for the extension's anon key.

**Files added:** `supabase/seed_match_schedule.sql`

### Face Values Seed — 3:00 PM ET
Added `supabase/seed_face_values.sql` with FIFA's official face value per category (CAT 1/2/3) for all 104 World Cup 2026 matches, taken from the December 11, 2025 randomized drawing. Public read RLS so the extension and dispatcher can resolve `(match_number, category) → face_value` without needing a service-role key.

**Files added:** `supabase/seed_face_values.sql`

### Version Update Checker + Footer Link — 2:00 PM ET
Extension now checks GitHub for the latest version (via raw `manifest.json`) on popup open, debounced to once every 6 hours via `chrome.alarms`. Shows a banner at the top of the popup if a newer version is available, with a one-click link to the Chrome Web Store listing. Added a `fifaticketscout.com` link to the popup footer alongside Buy Me a Coffee and the Etsy shop. Bumped extension version to **2.1.0**.

**Files changed:** `popup.js`, `popup.html`, `popup.css`, `background.js`, `manifest.json`

---

## April 11, 2026

### Supabase Data Sync — 5:30 PM ET
Every completed scan now syncs seat data to Supabase. All users (free and Pro) contribute crowdsourced data. Each install gets an anonymous visitor ID. Scan history is preserved as full snapshots for future price trend analysis. Match summaries are aggregated per match with hourly snapshots for trend charts. Sync is fire-and-forget — never blocks scanning, silently fails if backend is unreachable.

**Files changed:** `background.js`, `manifest.json`
**Files added:** `supabase/schema.sql`, `supabase/functions/ingest-scan/index.ts`

### Pro Tier & License Key System — 12:00 AM ET
Added Gumroad-based license key verification with a numeric tier system (level 0/10/20/30). Free users get Balanced scan speed and single-game storage. Pro users (level 10+) unlock Stealth, Cautious, and Aggressive scan speeds plus multi-tab support. License section in the popup with activation/deactivation UI. Re-verifies license every 24 hours via `chrome.alarms`. Extension works identically if Gumroad is unreachable (cached license). License provider is modular — one function to swap if we change payment providers.

**Files changed:** `background.js`, `popup.js`, `popup.html`, `popup.css`, `manifest.json`

---

## April 10, 2026

### Retry Blocked Tiles — 6:31 PM ET
When a tile gets blocked by bot detection (403), it's now retried after a 3-second cooldown instead of being permanently skipped. Blocked tiles are collected during the first pass, then retried as a batch. If still blocked, the scan completes with partial data instead of failing entirely.

**Files changed:** `injected.js`

### Clear Seats on Tab Re-navigate — 5:45 PM ET
When navigating back to a previously scanned game on the same tab, old seat data is now cleared before the fresh scan starts. Also clears scanned state on page refresh via `chrome.tabs.onUpdated` so auto-scan always fires on reload.

**Files changed:** `background.js`

### Resilient 403 Handling — 4:30 PM ET
Intermittent 403 blocks from DataDome are now skipped instead of aborting the entire scan. Only aborts after 3 consecutive blocks. Removed exponential backoff on 403s. Broadened CAPTCHA detection to catch any non-JSON 403/429 response.

**Files changed:** `injected.js`

### 10k Tile Grid (Mimics Site Pattern) — 3:00 PM ET
Switched from a variable-size tile grid (20k/50k) to a fixed 4×4 grid of 10k×10k tiles covering 0-40k coordinate space. This matches the tile sizes and alignment the FIFA site's own client uses when a user clicks through blocks. Speed profiles now only control delay between tiles (16 tiles for all speeds). Significantly reduces bot detection triggers.

**Files changed:** `injected.js`

### Multi-Tab Support — 2:00 PM ET
Multiple games can now be open in different tabs simultaneously. The popup auto-detects which game to show based on the active tab's URL. Scans route to the correct tab via `tabId` tracking. No more game data being wiped when switching between matches. Tab cleanup on close.

**Files changed:** `background.js`, `popup.js`

### Scan Speed UI — 12:00 PM ET
Added scan speed selector (Stealth, Cautious, Balanced, Aggressive) in the match header with emoji buttons. Pill progress indicator shows scan percentage and elapsed time. Speed selection persists across popup open/close. Match info caching prevents UI flicker during scan updates.

**Files changed:** `popup.js`, `popup.html`, `popup.css`, `background.js`, `content.js`, `injected.js`

### $NaN Price Fix — 11:00 AM ET
Seats with null/undefined prices are now filtered out of the dashboard and CSV export. Prevents "$NaN" from appearing in the stats bar.

**Files changed:** `popup.js`

---

## April 6, 2026

### Etsy Shop Links — 9:18 AM ET
Added links to My Son's Etsy Shop (fidgetforge6.etsy.com) in two places: replaced the refresh button in the header with an Etsy "E" icon (orange hover, tooltip "My Son's Etsy Shop"), and replaced the GitHub footer link with an Etsy footer link.

**Files changed:** `popup.html`, `popup.css`, `popup.js`

### Filter Out In-Cart Seats — 9:15 AM ET
Seats with `exclusive=false` (likely locked in another user's cart but not yet purchased) are now excluded from the dashboard and CSV export. These seats appear in the API data but aren't actually available to buy, so showing them was misleading.

**Files changed:** `popup.js`

---

## April 5, 2026

### Fix Clear & Rescan Not Recapturing Data — 11:27 AM ET
Fixed bug where refreshing the page after Clear & Rescan wouldn't recapture seat data. Root cause: the `scannedGames` Set in the background service worker wasn't cleared when storage was wiped, so `autoScan` thought it had already scanned. Now sends `CLEAR_DATA` message to the background to reset both storage and in-memory state.

**Files changed:** `background.js`, `popup.js`

### Clear & Rescan Button — 11:09 AM ET
Renamed "Scan All Sections" to "Clear & Rescan". Clicking it now clears all captured data and prompts the user to refresh their browser to repull fresh data. Simpler and more predictable than the previous background scan approach.

**Files changed:** `popup.js`, `popup.html`

### Clear Seats Before Scan — 8:12 PM ET (Apr 4)
When a scan is triggered, existing seats for the game are now cleared first so the results are a fresh snapshot rather than accumulating stale data.

**Files changed:** `background.js`

---

## April 4, 2026

### Persist Filter State — 5:45 PM ET
Category tab and seats-together selections now persist when the popup is closed and reopened. Previously all filters reset to defaults every time. Uses `chrome.storage.local` to save and restore state.

**Files changed:** `popup.js`

### Context-Aware Empty States — 5:30 PM ET
The popup now detects whether you're on the FIFA site, a seat map, or elsewhere, and shows contextual guidance instead of a generic "No data captured yet" message. Includes an "Open FIFA Resale Site" button when off-site. Removed redundant refresh button. Larger, cleaner logo in empty state. Added `tabs` permission.

**Files changed:** `popup.js`, `popup.html`, `popup.css`, `manifest.json`

### "Seats Together" Multi-Select Toggle — 5:02 PM ET
Redesigned the seats-together filter from single-select "N+" buttons to multi-select toggle buttons (`1 | 2 | 3 | 4 | 5 | 6+`). All sizes are ON by default. Users toggle OFF sizes they don't want — for example, turning off "1" hides single seats. Multiple selections are supported (e.g. only "2" and "3" active). "6+" covers clusters of 6–8 consecutive seats. Toggling all off resets to all ON. Stats, histogram, and Best Deals all update to reflect the filter.

**Files changed:** `popup.js`

### Scan Reliability: Jitter, Backoff & ETA — 4:39 PM ET
Merged scan improvements: randomized delay between requests (200–700ms jitter), exponential backoff on failures (2s → 15s cap), and estimated time remaining in the progress bar (e.g. "42% · ~12s left").

**Files changed:** `injected.js`, `popup.js`, `background.js`, `content.js`

### "Seats Together" Filter — 12:49 PM ET
Added toggle buttons for filtering seat clusters by group size. Filter acts as a primary control — stats, histogram, and Best Deals all update to reflect the selected group sizes. Shows a seat count badge when filtering is active.

**Files changed:** `popup.js`, `popup.css`

### Fix Host Permission Wildcard — 8:01 AM ET
Fixed an invalid wildcard pattern in `manifest.json`. Changed host permissions to use the correct `*.tickets.fifa.com` glob pattern, resolving extension load errors on some Chrome versions.

**Files changed:** `manifest.json`

### Support All FIFA Resale Currency Subdomains — 7:52 AM ET
Updated `manifest.json` host permissions and content script matches to work across all FIFA resale subdomains (e.g. `fwc26-resale-usd.tickets.fifa.com`, `fwc26-resale-cad.tickets.fifa.com`, `fwc26-resale-eur.tickets.fifa.com`, etc.) instead of only the USD subdomain.

**Files changed:** `manifest.json`

---

## April 3, 2026

### Load-from-Source Install Instructions — 11:24 PM ET
Added step-by-step instructions to the README for installing the extension directly from source via Chrome's "Load unpacked" developer mode, as an alternative to the Chrome Web Store.

**Files changed:** `README.md`

### Screenshots in README — 11:13 PM ET
Added screenshot images to the README showing the extension dashboard and Best Deals view.

**Files changed:** `README.md`

### Privacy Policy, Store Assets & Permissions — 11:04 PM ET
Created a full privacy policy (`PRIVACY.md`) documenting that all data stays local with no external transmission. Added Chrome Web Store promotional images and screenshots to `store-assets/`. Updated `STORE_LISTING.md` with detailed permission justifications for the store review process.

**Files changed:** `PRIVACY.md`, `STORE_LISTING.md`, and 5 image assets added to `store-assets/`

### ISC License & README Disclaimer — 10:23 PM ET
Added the ISC open-source license (`LICENSE`). Added a disclaimer to the README noting the extension is for educational/personal use and that users are responsible for compliance with FIFA's terms of service.

**Files changed:** `LICENSE`, `README.md`

### Chrome Web Store Listing Copy (PR #1) — 10:05 PM ET
Merged PR #1 with two changes:
- Rewrote the README to accurately reflect the extension's real behavior: API interception (not scraping), auto-scan functionality, price distribution histograms, and CSV export
- Created `STORE_LISTING.md` with full Chrome Web Store submission copy including short/long descriptions, category tags, and a submission checklist

**Files changed:** `README.md`, `STORE_LISTING.md`

### Initial Release — 9:32 PM ET
First commit of FIFA Ticket Scout, a Chrome extension (Manifest V3) for tracking real-time FIFA World Cup 2026 resale ticket prices. Core features:
- Automatic interception of FIFA ticketing API responses (fetch and XHR patching)
- Background service worker for data processing and seat deduplication
- Multi-layer messaging architecture (injected.js → content.js → background.js → popup.js)
- Full seat map scan via 5x5 tile grid covering the 100,000x100,000 coordinate space
- Interactive popup dashboard with match info, price stats, category tabs, price distribution histogram, and "Best Deals" consecutive-seat clustering
- Block breakdown table with per-section price ranges
- CSV export with match metadata
- Auto-scan triggered on new match detection

**Files added:** `background.js`, `content.js`, `injected.js`, `manifest.json`, `popup.html`, `popup.js`, `popup.css`, icons, `.gitignore`, `README.md` (12 files, ~2,150 lines)
