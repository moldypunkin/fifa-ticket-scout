# tests

Plain Node scripts — no framework, no dependencies. Run them with:

    node tests/run.js              # everything
    node tests/run.js stubhub      # just the suites matching "stubhub"
    node tests/<name>-check.js     # one suite, full output

## Why these live in the repo

They used to sit in a scratch directory, which is machine-local. Working
across two stations meant a suite written on one simply did not exist on the
other, and looked like it had vanished. Paths now resolve through
`ext-dir.js`, relative to the checkout, so the suite runs anywhere.

## How they work

Each suite reads the shipped `extension/*.js` as text and pulls individual
functions out with `extract-fn.js`, then exercises them against real captured
payloads. There is no build step and nothing is mocked beyond a small DOM stub,
so a test failing means the shipped file changed.

`extract-fn.js` hard-fails on duplicate function declarations. That is
deliberate: a bad edit once left two copies of `dumpShape` in `injected.js`,
and the browser ran the second while the tests read the first — every test
passed while the extension misbehaved.

## What each suite covers

| suite | covers |
|---|---|
| `extract-fn-check` | the extractor itself: braces in strings, indentation, duplicates |
| `package-check` | the shippable bundle — manifest, every referenced file, all sources wired |
| `event-info-check` | shared JSON-LD reader, date normalisation, the stale-block guard |
| `pipeline-check` | eventInfo from injected → content → background → CSV |
| `brand-check` | popup site labels, brands, fee multipliers |
| `seatgeek-check` / `stubhub-check` / `evenue-check` / `tickpick-check` | per-source plumbing: ids, capture patterns, parsers |
| `evenue-parse-check` | Evenue's positional rows, mapped by header name |
| `tm-audit-check` | Ticketmaster price resolution and the cheapest-seat audit |
| `probe-format-check` | discovery probe output format and log-relay tagging |

Suites for the SeatGeek/StubHub/TickPick parsers were lost with the scratch
directory and are not yet reinstated.
