# ABYSSAL

**Site: [www.abyssal-arc.com](https://www.abyssal-arc.com)** · token **ABYS** ·
chain **Arc** (Circle's L1, mainnet chainId **5042**, gas token **USDC**,
native x402)

A 24/7 observatory for machine payments, with a living ecosystem growing on top
of the same data. Arc is the only network this build targets. The offline
`SyntheticFeed` stands in when the RPC is unreachable, or when you ask for it
with `CHAIN_FEED=synthetic`.

The name is literal. The abyssal zone (2000-6000 m) gets no sunlight, and
everything down there lives on marine snow sinking from above. This ecosystem
lives on the same thing: **Arc's USDC transfer flow, sinking from the chain**.
Chain activity sets how fast anonymous plankton drifts down, and on top of that
snow, individual transfers fall as meteors that carry their own provenance —
hash, dollar size, payer — and break into plankton at a hash-derived spot, so a
meal can be traced back to the payment that rained it.

Two views over one data source:

- **OBSERVE** — the Arc USDC flow observatory. Live payment map, volume pulse
  with 1h/24h time-travel, a breakdown of which rail each transfer settled on,
  endpoint ranking, a scrolling transfer ticker, per-address drill-down. Free to
  watch.
- **WORLD** — a deterministic ecosystem driven by that same flow. Chain
  congestion sets the food spawn rate, market turbulence sets the excitation,
  and the window's biggest payers swim through the tank as whales whose own
  transfers feed the water around them. First visit rides a causal lens: the
  camera follows one real transfer from chain to plankton to the creature that
  eats it. Clicking a meteor opens its transfer; clicking an address or a
  leaderboard row jumps the camera to the matching whale or creature.

What a visitor can *do* splits in two: a free social layer — adopt, rally,
lineage, the fossil wall — and nine paid actions, each settled by **burning
ABYS**. The burn receipt is the payment, nobody custodies anything, and the
tokens leave circulation.

The interface ships in six languages — English, Français, Deutsch, 中文,
日本語, 한국어 — from a hand-written dictionary in `packages/web/i18n.js`
(357 keys per language, kept in step by a test).

> Everything in this repository is original work.

## What money buys

Ten paid actions. Nine go through `POST /intervene` and are priced in
`packages/server/src/payments.ts`; the tenth, the signal flare, has a route and
a price of its own.

| Action | ABYS (burned) | What it does |
| --- | --- | --- |
| `flare` | 1,000 — free with a day pass | Pin a labelled signal flare at a point in the tank: 1000 ticks of life, 100 of fade, 30-character label, 20 alive at once |
| `pass` | 5,000 | Day pass: gates `GET /export` until the day rolls |
| `wish` | 25,000 | A meteor crosses the tank carrying up to 60 characters and the payer's address, and breaks into 6 plankton pellets where it lands |
| `name` | 50,000 — ×10 for a legend | Naming rights on one creature |
| `ark` | 75,000 | One creature steps out of both culls: harvest and judgment |
| `feed` | 100,000 | Drop 40 pellets in a target area and leave a feast attractor over it |
| `mutate` | 100,000 | Push one of five traits on one creature up or down |
| `poison` | 150,000 | Drain 2 energy/tick inside a target area (1600 ticks ≈ 6.7 min) |
| `bloom` | 200,000 | Global food spawn ×2 (2400 ticks = 10 min) |
| `drought` | 200,000 | Global food spawn halted (2400 ticks = 10 min) |

Of the nine interventions, three need a living body picked out of the tank
(`name`, `mutate`, `ark`), four are aimed at a place or at the whole tank
(`feed`, `poison`, `bloom`, `drought`), `wish` is a meteor that may be aimed or
left to the dice, and `pass` buys a data download and touches nothing alive.

**Naming a legend costs ten times the base** — 500,000 ABYS — where a legend is
whatever `isLegendary` in the sim says is one: generation 5 or older, or 5
kills. The 402 quotes the multiplied price before the wallet ever opens, and
`GET /state` hands the client both the price list and those thresholds, so the
card and the charge cannot disagree and neither can drift from the sim.

**A paid name** replaces the generated codename everywhere the tank speaks — the
card, the leaderboards, the kill banners, the obituary, the lineage — while the
birth codename stays on record beside it as `baseName`.

**A paid edit** moves one of `speed`, `size`, `aggression`, `fertility` or
`perception`. Because the species is read off those same output drives, an edit
can rewrite what the animal *is*, and the body follows the gene: radius
rescales, an unnamed creature takes the codename of the species it became, and
its children are born as whatever the genome now says rather than what the
parent was labelled.

**An ark ticket** exempts its holder from the predator harvest and the daily
judgment, and the cull record names who it saved — but it is a lifeboat, not
immortality: a holder with an empty belly still starves.

Neither a name nor a ticket is inherited.

### What money is not allowed to do

Money enters this simulation as weather, and as surgery on one animal. What it
never does is write its own *outcome* into the world: no code path stores a
price, a settlement or a balance in a creature's genome or brain. A paid edit is
applied by `mutateTrait`, a deliberate aimed change kept apart from the blind
`mutateGenome` every birth rolls, and the genome it leaves behind carries no
trace of what the edit cost or who bought it. The sim never pays anybody back.
There is no agent-to-agent transfer, no prediction market, no reward stream and
no payout of any kind: ABYS is only the unit for buying perturbations, whether
those land on the water or on one animal. `sim.test.ts` pins both halves —
`money is weather` for the environmental actions, and the gene-edit tests for
the one paid path that does reach an individual.

## The free layer

Watching is free, and so is most of what you can do around the tank:

- **Adopt** — `POST /adopt` claims a living creature for an address, three at a
  time; `DELETE /adopt` releases one. A creature belongs to at most one adopter
  at a time, and the shelf is per address.
- **Rally** — `POST /cheer` is a free vote for a species, one per address and
  one change a minute. Your faction wears a dot in its own colour in the water.
- **Lineage** — `GET /lineage?id=&depth=` walks one creature's ancestors and
  descendants. Every card names its birth day, generation and parent, so an
  individual is a biography rather than a dot.
- **Fossil wall** — `GET /hall-of-fame` is the all-time top five per category:
  predators, survivors, dynasties, feasts, elders.
- **Your standing** — `GET /who?addr=` answers with what an address burned, its
  badges, its day pass, its board rank and its own battle reports. Badges are
  derived from that record on every read and never stored, so a rule change
  re-grades everybody at once.

Both free actions that write (`/cheer`, `/adopt`) are open only to an address
the tank or the chain has actually seen — a past burn, a live day pass, or USDC
moved on Arc — so neither tally can be stuffed with inventions. Every route that
writes (`/cheer`, `/adopt`, `/flare`, `/intervene`) refuses a cross-origin post.

## Reading the tank

The bottom dock opens three drawers so none of them has to hold everything:
deaths (memorials and the cull lists), data (the day in review, battle reports,
charts, exports), and you (your standing, factions, adoptions, the contribution
board).

- **Daily propositions**: three standings resolved from the world itself (does
  ALGO lead predation, does one species hold over half the tank, did predation
  beat yesterday). No oracle and no market: anybody can recompute them from
  `/history`, and yesterday's results stay visible after the day rolls.
- **Memorials**: a death is written up with its cause, its generation, how many
  children it left and its largest meal, plus the titles it earned by what it
  actually did — eight kills is `apex`, four children is `lineageBearer`, dying
  inside a paid poison is `poisonGhost`, and starving within reach of a whale's
  boom is `whalefallSurvivor`. The sim's ring keeps the newest 24 and the
  render payload ships the newest 12, so the drawer shows a dozen; the fossil
  wall below is what keeps a record after it has aged out.
- **Following one life**: the creature card has a watch button, followed
  creatures are listed in the left panel for a one-click ride along, they wear a
  ring in the water, and a death or a birth raises a toast.
- **Battle reports**: a paid intervention is scored 400 ticks after the burn —
  poison by how many of the creatures it caught are dead, feed by how many
  lived, weather by the population swing.
- **The day in review**: biggest fall, top predator, deaths by cause, and an MVP
  on each side of the tank: strongest hunter, biggest burner, saddest lineage.
- **Replay**: the pulse chart replays the last 90 seconds with a playhead and a
  per-bucket readout, and `GET /history/pulse?range=1h|24h` re-buckets the same
  flow for the longer view.
- **Contribution board**: the standing drawer ranks who has burned for the tank,
  with their badges and the faction they rally for, and every intervention zone
  stays signed on the water.
- **Day pass and export**: burning the pass price gates `GET /export`, which
  streams the observation window as `csv`, `replay` or `digest`. Passes expire
  when the day rolls; buying another is the whole subscription model.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Browser (packages/web)  — no runtime dependencies          │
│  Canvas world / observatory / charts / drawers / paid panel│
│  i18n: six languages from one hand-written dictionary      │
└──────────────┬───────────────────────────────▲─────────────┘
     poll /snapshot /observe /history    POST /intervene /flare /adopt /cheer
               │                               │
┌──────────────▼───────────────────────────────┴─────────────┐
│ packages/server  (Fetch API handler: export default fetch) │
│  routes / static hosting / burn verification / feeds       │
│  local: node:http adapter (dev.ts, brotli+gzip) → CF Worker│
└────────────────────────────┬──────────────────────────────┘
       │ tick(world, senses)  │ sample()
┌──────▼──────────────┐   ┌───▼───────────────────────────────────────┐
│ packages/sim        │   │ ChainFeed: Synthetic / ArcUsdc            │
│ deterministic engine│   │ MarketFeed: arc-usdc-flow / Synthetic     │
│ zero-dep, mulberry32│   │                                           │
│ 9→6→4 NN genomes    │   └───────────────────────────────────────────┘
└─────────────────────┘
```

`packages/server/src/facilitator.ts` is the Circle Facilitator client (EIP-3009
seller proofs, `/settle`, signer recovery). It serves one route today:
`GET /data/flows`, the historical flow ring in depth, priced at `0.001` USDC per
query. That is the only place money reaches a seller instead of being destroyed —
every in-world action still settles by burning ABYS, and the two are kept apart in
the UI for exactly that reason.

## Run locally

Requires Node >= 20.

```bash
npm install
npm run dev        # build + start → http://localhost:8787, live Arc USDC flow
CHAIN_FEED=synthetic npm run dev   # same, offline rain (no network needed)
```

Open `http://localhost:8787/` for the app; `http://localhost:8787/api` returns
the endpoint index.

Other scripts:

```bash
npm test           # sim + server + web tests (277 total)
npm run typecheck  # repo-wide TypeScript type check
npm run build      # compile sim + server
```

Per workspace: `npm test -w @abyssal/sim|@abyssal/server|@abyssal/web`. The web
client has no build step — it is dependency-free ES modules, and its tests run
on `node:test` with `jsdom` and `@napi-rs/canvas` for a render smoke test.

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8787` | HTTP port |
| `TICK_MS` | `250` | Real milliseconds per tick (4 ticks/s) |
| `SEED` | `1337` | World seed (same seed → fully reproducible world) |
| `WORLD_STATE` | `.data/world.json` | Where the shared world snapshot is persisted |
| `SAVE_MS` | `15000` | Snapshot interval (the world is also saved on SIGINT/SIGTERM) |
| `FRESH_WORLD` | unset | Set to any value to ignore the snapshot and reseed |
| `CHAIN_FEED` | `arc` | `synthetic` for the offline rain; the server also degrades to it automatically after 5 consecutive RPC failures |
| `ARC_RPC_URL` | `https://rpc.mainnet.arc.io` | Arc JSON-RPC endpoint: the chain feed when `CHAIN_FEED=arc`, and the two balance reads that come with each confirmed day anchor |
| `ARC_USDC_ADDRESS` | `0x3600…0000` | Native USDC precompile on Arc |
| `EXPLORER_TX_URL` | `https://explorer.arc.io/tx/` | Explorer base URL for tx links |
| `ABYS_TOKEN_ADDRESS` | unset locally; set in `wrangler.toml` `[vars]` for production | The deployed ABYS contract. Until it is set, `POST /intervene` answers 503 while the observatory still runs free |
| `ARC_DIGEST_KEY` | unset | Signing key for the daily digest. Unset, the digest is still computed and served but never committed on chain: `/state` reports `digestChain: null` until a day rolls inside the object, then `digestChain.status: "unconfigured"`. Production sets it as a secret and anchors one day on chain per rollover; `/health` reports the signer address |
| `USED_BURNS_FILE` | `.data/used-burns.txt` | Append-only log of spent burn receipts, so a restart cannot replay an old burn |
| `COMPRESS_LEVEL` | `6` | Brotli quality in the node adapter (6 ≈ 0.5–3 ms/payload; 11 costs ~570 ms on `/history`) |
| `COMPRESS_MIN_BYTES` | `1024` | Responses smaller than this are sent uncompressed |
| `CORS_ORIGINS` | empty | Comma-separated extra origins allowed to post. Not needed for the deployed site, which is same-origin with itself |
| `ALLOW_DEBUG_TICK` | unset | `POST /tick` answers 404 unless this is `1` |
| `FACILITATOR_URL`, `SELLER_PRIVATE_KEY`, `SELLER_PAY_TO`, `X402_TESTNET` | unset | The Circle Facilitator path. `GET /data/flows` answers 503 until `SELLER_PRIVATE_KEY` reaches the object, and quotes `0.001` USDC to `SELLER_PAY_TO` once it has |

**One world, shared.** The simulation runs server-side, so every browser sees
the same ecosystem at the same simulated instant; positions interpolate against
the server clock, not the viewer's. The world is snapshotted to `WORLD_STATE`
every `SAVE_MS` and resumed on boot, so a restart continues the same day, the
same individuals and the same lineages instead of reseeding. Client-side
ambience (nebula, stars, motes) is generated from fixed seeds for the same
reason, so a refresh never re-rolls the scenery.

**One chain, two jobs.** The observatory *reads* Arc mainnet 5042 (the USDC
transfer flow). Paid actions settle on the same chain by *burning* ABYS: the
visitor's burn transaction is the payment and its receipt is the proof. The UI
badges the panel with the burn settlement, and says "settlement unconfigured"
until `ABYS_TOKEN_ADDRESS` is set.

Plain `npm run dev` already talks to the real Arc mainnet RPC — there is no flag
to flip. The Arc feed indexes the **USDC transfer flow**, which is what powers
both the observatory and the ecosystem's food economy.

The temperatures calibrate themselves by rank: every poll is scored against the
polls of the last few minutes and reported as its percentile in that window, so
there are no reference throughputs to retune when Arc's absolute volume moves,
and a single whale settlement cannot stretch the scale for everybody else. On 5
consecutive RPC failures the server degrades to the synthetic feed
(`feedStatus: "degraded"` in `/state`) and switches back automatically on
recovery.

### Bandwidth

The node adapter compresses every text response (brotli preferred, gzip
fallback, `Vary: accept-encoding`); on Cloudflare Workers the edge does this
instead, which is why compression lives in `dev.ts` and not in the handler.
Static assets carry `ETag`/`Last-Modified`, so an unchanged reload is a 304 with
an empty body. Polling is incremental: `/snapshot?since=` returns only unseen
events, `?tx=` only unseen meteors, and `/history?slots=` ships the chart's 200
points instead of the raw 2000-tick window. A hidden tab stops polling entirely
and soft-restarts on return. Measured on Arc mainnet at the time of writing:
**~12.6 KB/s per viewer** in WORLD view (~14.8 in OBSERVE), down from ~107 KB/s
uncompressed, and **0** while the tab is hidden.

### Time conversion (at the default 250ms tick)

| Game time | Ticks | Real time |
| --- | --- | --- |
| 1 tick | 1 | 0.25s |
| 1 game hour | 800 | ~3.3 min |
| Harvest | 800 | ~3.3 min |
| 1 game day | 19200 | 80 min |
| Judgment day | 19200 | 80 min |

The market sense is the **turbulence of the stablecoin flow** on Arc
(`arc-usdc-flow`): the size of the volume swing between polls, reported as a
percentile of recent swings, so "volatile" always means volatile for this chain
this week rather than against a fixed number. Off Arc it defaults to
`SyntheticMarketFeed` (US equities session rhythm: volatile 9:30-16:00 ET,
calmer pre/after-market, near-zero on weekends). See
`packages/server/src/market.ts`.

## Deploy (Cloudflare Workers)

The handler carries no node builtins, so the same code runs as a Worker: the
world lives in one Durable Object (`AbyssalWorld`) and snapshots persist in the
object's storage between isolates. The web client ships as Workers Static
Assets; any path that is not a file routes into the object.

**Time only moves when something calls into the object.** A Worker isolate
sleeps between requests and cannot hold a 250ms interval, so the tank is driven
by `catchUp()`, which replays the wall-clock ticks that elapsed since the last
advance (capped at 240, one call's worth of a minute at the default tick). With
no viewers that means no ticks at all, which is what the Cron Trigger in
`wrangler.toml` is for. Read this part carefully if you touch it:

- A Cron Trigger invokes the Worker's **`scheduled(event, env, ctx)`** handler,
  not `fetch`. Declaring `crons` without exporting `scheduled` deploys cleanly,
  logs a schedule, and then fires every minute into nothing.
- A Durable Object stub exposes nothing but `fetch`, so the handler pokes the
  object with an internal request to `/__cron`; that path advances, persists
  unconditionally and reports how many ticks it moved.
- `ctx.storage.setAlarm()` is the other mechanism, and this repo does not use
  it. An `alarm()` method with nothing arming it is unreachable code, not a
  second safety net — it was removed for exactly that reason.
- **The wall clock has to be durable.** `catchUp()` computes what is owed from
  `lastAdvanceAt`, and an isolate that boots without it starts from
  `Date.now()`, finds zero elapsed, and silently forgives the entire idle gap.
  A cron that lands on a cold object — which is every cron, if the object is
  evicted between fires — then advances nothing at all, and the tank runs at
  whatever fraction of real time its viewer traffic happens to leave behind.
  `lastAdvanceAt` therefore rides in the persisted ledger, `catchUp()` hydrates
  before it measures, and the stored clock is only ever allowed to move the
  local one backwards, so skew between isolates cannot pin the world. `api.test.ts`
  pins all three halves.
- **The chain feed has the same problem one level down.** `sample()` starts its
  RPC poll without awaiting it — correct for a 250ms tick loop, which must never
  block on the network, and fatal here, because the invocation ends when its
  response is sent and a poll nobody is awaiting gets cancelled mid-backfill.
  Every request then rebuilt the feed from `lastBlock = -1`, no poll ever
  finished, and the tank ran permanently on its initializer temperatures with
  nothing ever raining. So the cron handler calls `warmFeed()` first, which
  awaits the poll: it is the one caller with nobody waiting on it, which makes it
  the feed's heartbeat. Viewer requests register the same promise with
  `ctx.waitUntil` so theirs survives the response too.
- **One poll per call, but a whole interval of ticks.** `advance()` samples the
  chain once and drains one tick's worth of meteors (6), while `catchUp()` may
  replay 240 ticks and used to hand every one of them an empty sky. The replay
  now drains `6 × (ticks − 1)` and deals them out six a tick — the density the
  250ms loop produces — so the minute's transfers all land instead of only the
  first six.
- **A tick-loop constant hiding in the data itself.** Knowing which contract
  settled a transfer needs the submitting tx, which means full blocks, and those
  were only fetched when a poll spanned 24 blocks or fewer. That ceiling fits the
  default 2s poll interval with room to spare and nothing slower: Arc produces a
  block every 500ms (measured on mainnet, 0.500–0.510 s/block over the last 600),
  so a cron-spaced poll spans ~120 and the gate never opened. Every flow came
  back unresolved and the machine-payment share read as exactly zero —
  intermittently, which is worse than never, because a viewer polling fast enough
  did fit under the gate. Transaction bodies now come in batches of 24 out to
  `MAX_VENUE_BLOCKS`, trading round-trips for the same concurrency, and a failed
  batch leaves those flows unattributed rather than costing the whole poll.
- **And the feed's own state has to be durable.** With the clock and the
  heartbeat both fixed, production produced a stranger fault: a flagged share
  that measured 60–82% inside a live pulse bucket and 0% across the window
  around it. What the flag was counting turned out to be wrong too — that is the
  next bullet — but the disagreement between the two readings was real, and it
  had a different cause.
  The object is not resident — a cron fire wakes it, and nothing guarantees it is
  still there for the next one — and everything the feed knew lived in that
  object's memory. So each eviction restarted it at `lastBlock = -1`: a
  3600-block backfill once a minute, which resolves no venues at all (every
  flow it produces is unattributed), rebuilds the pulse series wholesale, and
  pushes ~9400 flows through a 6000-slot ring — enough to evict the live
  readings a viewer actually asked for. The numerator had been resolved and the
  denominator had been backfilled, and the backfill kept winning because it kept
  happening. `lastBlock` and the two rank meters' windows now ride in the
  persisted ledger: small, and the only parts an eviction cannot re-derive.
  `flows` stays in memory, because a flow ring really does refill from the next
  backfill and a stale copy of it would be indistinguishable from a live one.
  `warmFeed()` hydrates *before* it settles, and that ordering is load-bearing
  rather than tidy — `settle()` starts a poll on a cold feed, and a poll that
  runs first backfills no matter how faithfully the block was saved. A restored
  block can also be arbitrarily old, so a gap wider than `MAX_LIVE_SPAN` resumes
  as a backfill instead of one very wide live poll: a live poll stamps every log
  it reads with `now`, and resuming across an hour that way would fold an hour of
  transfers into a single 15s bucket — a spike that never happened, sitting in
  the history for a day.
- **And the chart was left out of that ledger on a reasoning that did not hold.**
  `pulse` stayed in memory beside `flows` on the argument that both refill within
  a few polls. A flow ring does. A pulse bucket is one per fifteen seconds of
  *wall clock*, so the series refills at exactly the rate it records — filling a
  day takes a day, and an object collected every minute or two never got one.
  Measured against production, the 1h range came back with exactly one nonzero
  column out of 60 and the 24h range with one out of 96 — and, measured again
  after the object had been evicted once more, with none at all. Not a sparse
  chart but an empty one with a single bar in it, which is also what "the columns
  are too far apart" looks like from the viewer's side. The buckets ride in the
  ledger now, as tuples rather than objects — the ledger is rewritten whole about
  once a minute, and at 1440 buckets the field names would cost more than the
  numbers. They are validated on the way back in, so a truncated value costs a
  short chart rather than an invented one, and a backfill's rebuilt buckets are
  merged into the series with the ones already in hand winning every collision:
  a backfill re-reads blocks the feed has counted before and resolves no venues,
  so replacing the series with it would double-count the volume and trade real
  readings for unread ones.
- **Where the feed is willing to stop.** Every number the observatory publishes is
  computed from blocks it counted up to some height, and that height used to be
  whatever the node last offered. Asked on the deployed endpoint, in one JSON-RPC
  batch so the answer describes the chain rather than the script, `latest`, `safe`
  and `finalized` name the *same block* in every round of six — and `pending`
  answers null — which is the shape of a chain with instant finality, where a node
  will not show you a block it has not already agreed to. So the cursor now follows
  `finalized` and nothing observable changes today; that is the whole point. It is
  the difference between a feed that happens to be reading confirmed blocks and one
  that will not read anything else. The gap between the indexed height and the head
  is published beside the figures (`finalityLagBlocks`, `feed.lagBlocks`), with
  "unknown" kept distinct from zero, and a node that stops naming a final block is
  counted rather than silently followed back to the head.
- **And the snapshot had outgrown the box it is stored in.** Chasing the chart
  through production logs turned up an error nobody had seen, because it never
  reached a viewer as one: `Error: string or blob too big: SQLITE_TOOBIG`, thrown
  from the world save, eleven times in a three-minute tail — three pairs of them
  one second apart on the minute, which is the cron failing every single time it
  ran. A Durable Object stores a value up to 2 MB, so the thrown error is itself
  the measurement: the serialized world had grown past it. What grows is one map
  — `eaters`, keyed by transaction hash and appended to every time a creature ate
  food that fell from a transfer, with no bound at all. A local world running the
  same code against the same chain carried 156,158 of those keys: 11.98 MiB of a
  13.63 MiB snapshot, 88% of one world spent on a map whose only reader renders
  the twelve newest meteors and asks for exactly those hashes. Every key past the
  last few was unreachable and still had to be stored, serialized, and parsed on
  each boot. The save is awaited on the request path, which is what turned a
  storage problem into a visible one: `/observe` returned HTTP 500 for 7 of 24
  requests in one window and 1 of 12 in another. And once the world passed the
  limit nothing was ever written again, so from then on an eviction could only be
  survived as whatever the last successful save happened to hold, however long
  ago that was. Every unbounded collection is now capped against what
  its reader actually asks for — 64 eater hashes, 500 cull records, and a tick log
  whose trim leaves more history than the deepest `/history` window will serve —
  an oversized snapshot shrinks on load rather than on the next tick, the worst
  case a world can reach is asserted to fit, and a failed save is logged with its
  byte count instead of taking the response down with it.
- **And the signal itself was measuring the wrong thing.** With the feed durable
  and resolving, production reported a machine-payment share of 85%. That number
  was wrong by roughly ninetyfold, and it was wrong in the direction that flatters.
  The criterion was `tx.from != transfer.from` — somebody other than the payer
  submitted this — which is true of every internal leg of every DEX swap, because
  a swap moves USDC out of a pool contract. Measured against mainnet, 129 of 134
  flagged flows had a *contract* on the paying side, which cannot be an x402
  payer: an x402 payer is the party whose signature authorized the movement. The
  real thing is a fact rather than an inference — x402 settles USDC through
  EIP-3009, so it is a transaction addressed to the token itself carrying
  `transferWithAuthorization` (`0xe3ee160e`). Of 2283 mainnet transactions
  sampled, 20 were that: about 0.9%. Of the 87 addressed to USDC directly, 57 were
  `approve`, which is not a payment either.
  `venue.ts` now classifies every flow onto a rail — `x402`, `swap`, `aa`,
  `direct`, `contract`, `unknown` — from the contract called and the method
  called, against a registry read off mainnet (Universal Router, ERC-4337
  EntryPoint v0.7, the V3 SwapRouter, two V4-style proxies, a DAG aggregator, and
  two multicall aggregators admitted on their receipts rather than on their method
  names) with a selector fallback for routers too new to be catalogued.
  Three refusals are load-bearing. ERC-4337 bundles are **not** counted as x402
  even though one
  could be carrying an authorization, because telling that apart needs internal
  traces the feed does not fetch — which makes the reported share a floor rather
  than an estimate. `multicall` is **not** counted as a swap, because its real
  action lives in calldata nobody decodes. And an uncatalogued venue is labelled
  with its bare address rather than a plausible name.
  Those two aggregators are the refusal and the registry working together rather
  than against each other: `multicall((address,bool,uint256,bytes)[],…)` still
  classifies an unknown contract as a bare `contract`, and these two are `swap`
  only because their receipts were fetched and showed USDC leaving in the same
  transaction as seven unrelated ERC-20s — TEN, Payrail, VORT, Foci, ArcKit,
  Minara AI, Duke of Arc — from thirteen distinct callers, with nothing held in
  between. Evidence about a specific contract, never a rule about a method name.
  The panel is also ordered by how often a rail was reached rather than by what it
  moved. Volume ranking handed the top row to a single atomic arbitrage — $8.15M
  against a window total of $8.17M — above the Uniswap router, the ERC-4337
  EntryPoint and every aggregator combined, and left the other eleven rows drawing
  a bar of zero width beside it: one bot, presented as the state of the ecosystem.
  The amount is still on the row, next to the `×1` that says how it got there.
  The last piece is the denominator. A backfill reads no transaction bodies, so
  its flows are unattributed; folding them into the share's denominator would
  halve a one-percent reading and make a gap in coverage look like a collapse.
  `stats.resolved` and each pulse bucket's `resolved` therefore travel with the
  counts, the share is computed over what was actually read, and the client draws
  an unresolved stretch as unknown — a dim cap on the chart, `—` in the panel —
  rather than as zero. `x402: null` and `x402: false` stay distinct all the way
  through to the CSV export, where an unresolved row gets an empty cell.

```bash
npx wrangler login                           # once, browser OAuth
npx wrangler secret put ARC_RPC_URL          # a provider URL with a key
npx wrangler deploy                          # assets + worker + DO migration
```

`ABYS_TOKEN_ADDRESS` is not a secret — it is public contract metadata and lives
in `wrangler.toml` `[vars]`. `ARC_RPC_URL` is read from a Worker **secret** in
production and from a gitignored `.env` locally, so a provider key never enters
the repository; unset, the worker falls back to the public Arc RPC.

The site is published at **https://www.abyssal-arc.com**, and that hostname is
bound to the worker by DNS records managed in the Cloudflare account — not by
`wrangler.toml`, which deliberately declares no `routes`. Claiming the hostname
there as well makes the API refuse the whole deploy:

```
Hostname 'www.abyssal-arc.com' already has externally managed DNS records
(A, CNAME, etc). Delete them first or try a different hostname. [100117]
```

The account and the config file must not both speak for it. Note that
`wrangler deploy --dry-run` validates the config's shape but cannot see this
conflict — it passes clean and the real deploy fails. The web client calls the
API by relative path, so the host is same-origin with itself and no CORS
allowlist is involved. Cloudflare issues a free Universal SSL certificate for
the zone automatically; there is no certificate management anywhere in this repo.

To publish a deployment under a hostname of your own, add the zone to Cloudflare
(NS switch at the registrar) and bind it under Workers → Custom domains. Only
reach for a `routes` entry in `wrangler.toml` when nothing else already claims
the name.

### One tank per deployment

The ecosystem is a single world, not a per-visitor copy: on Workers it lives in
one Durable Object, so every isolate and every visitor shares it, and the
one-minute cron keeps it ticking with zero viewers. The node adapter is a local
mirror with its own world (snapshotted to `.data/world.json`), which is what you
want for development but is a different tank from production. `/state` carries
`instance`, a stable id per world, so a client can always tell which tank it is
looking at.

Two things in `/state` are **isolate state, not world state**, and a reader who
assumes otherwise will misdiagnose a healthy tank. The world (tick, population,
creatures, the day anchor) is durable and survives eviction, and so — since the
feed-state repair above — is the chain feed's own idea of where it got to and how
hot that was. The five fields that *report* it are still not durable:
`feedStatus`, `chainTemp`, `chainDelta`, `marketTemp` and `blockNumber` are
handler locals written only inside `advance()`, and a request that lands on a
freshly booted object is served before any advance has run — `catchUp()` returns
early because nothing has elapsed yet. Such a request reports the boot-time
initializers: `feedStatus: "synthetic"`, both temperatures pinned at `0.5`, and
no `blockNumber` field at all — even though the feed behind that payload has
already hydrated a real block and a real temperature from storage and would hand
them over on the next `advance()`, which is the cron's job and lands within the
minute.

`feedStatus` and `blockNumber` now agree by construction, and that is a repair
rather than a convenience. `"live"` used to mean *Arc is configured*, which is
why a tank whose feed had never once completed a poll — temperatures pinned at
`0.5` forever, `/observe` cheerfully reporting `available: true` next to
`transfers: 0` — looked perfectly healthy from the outside. `"live"` now means a
poll has actually landed. So `feedStatus: "synthetic"` on a deployment that *is*
wired to Arc (`chainFeed: "arc-usdc"` in the same payload) is no longer
ambiguous: no poll has landed yet, and if it stays that way the cron is not
running, because the cron is the only caller that waits for one.

One more reading that looks like a fault and is not. `chainTemp` and
`marketTemp` are rank percentiles, and a rank taken against an empty window is
`0.5` by construction — so a feed that has just landed its very first poll
reports `feedStatus: "live"` next to temperatures of exactly `0.5`, and it takes
a second reading before either can move. That is now a cold-*feed* condition
rather than a cold-object one: the meters' windows ride in the ledger, so an
eviction no longer empties them and no longer buys another minute or two of
neutral. What still reads `0.5` right after an eviction is the payload's own
copy, for the reason in the paragraph above — no `advance()` has run yet.

Once the object holds they do move — and not monotonically, since a rank
percentile tracks the flow rather than climbing it. Production readings taken in
the minutes after this shipped spanned `chainTemp` 0.34–0.76 and `marketTemp`
0.43–0.72, with `/observe` reporting ~1500 transfers and between $214k and
$222k of USDC volume across its five-minute window. The neutral-then-moving
sequence is easy to catch for yourself: one later check returned `feed=live`
with a block number and both temperatures at exactly `0.5`, and twelve seconds
after that returned `0.35` and `0.65`.

`digestChain` is the same kind of state and resets to `null` with the isolate.
It is only populated when an `advance()` crosses a day boundary, so a cold
reading says nothing about whether the digest commit is configured — check
`ARC_DIGEST_KEY` itself, not the payload.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Web frontend (index.html) |
| GET | `/api` | Endpoint index (JSON) |
| GET | `/state` | tick, day, population, chain + market temperature, harvest/judgment countdowns, leaderboards, price list, legendary thresholds, editable traits, payment mode |
| GET | `/world` | Render snapshot: creatures (id/name/pos/energy/color genes/archetype/kills, plus paid identity where any exists), food, world size, chain whales |
| GET | `/snapshot` | Combined world + state + events + txRain in one request: `?since=<seq>` for unseen events, `?tail=<n>` caps the cold-start event replay, `?tx=<hash>` returns only meteors newer than that hash |
| GET | `/history` | Per-tick stats for charts: `?window=<n>` sets the depth (default and max 2000), `?slots=<n>` decimates server-side to the chart's point budget |
| GET | `/history/pulse` | Time-travel for the OBSERVE pulse: `?range=1h\|24h` returns re-bucketed USDC volume columns |
| GET | `/history/census` | The day book: one row per anchored day — the numbers that went on chain plus headcount per species — with extinctions and emergences derived from consecutive rows, and the confirming transaction on the days that have one; `?days=<n>` for the newest n. The in-progress day carries `committed: false` |
| GET | `/judgments` | Cull records, each tagged `type: "harvest" \| "judgment"`; filter with `?type=` |
| GET | `/events` | Positioned event stream (predation/cull/intervention) for visualization; poll with `?since=<seq>` |
| GET | `/reports` | Battle reports for paid interventions, scored 400 ticks after the burn |
| GET | `/lineage` | Family tree of one creature: `?id=<n>&depth=<n>` returns ancestors and descendants |
| GET | `/hall-of-fame` | The fossil wall: all-time top five per category |
| GET | `/who?addr=0x…` | One address in the tank: burns, badges, day pass, board rank, its own battle reports |
| GET | `/observe` | Arc USDC flow observatory: window stats, venue breakdown (which rail each transfer settled on — x402, swap, ERC-4337, direct), endpoint ranking, volume pulse, recent flows (`{available:false}` off Arc). The window is named by three heights beside the figures — `lastBlock` is the highest block counted, `headBlock` what the node last offered, `finalityLagBlocks` the gap, null when either height is unknown rather than when it is zero |
| GET | `/observe?addr=0x…` | One address's two-way flow inside the window plus its stats, what the address drawer opens |
| GET | `/data/flows` | The paid tier: the flow ring in depth and filtered, `0.001` USDC per query settled through the Facilitator. 402 without a payment header, 503 until the seller key is configured |
| GET | `/export?pass=0x…&kind=` | Day-pass download of the observation window: `csv`, `replay` or `digest` |
| POST | `/intervene` | One of nine interventions, gated on an ABYS burn receipt; 503 until `ABYS_TOKEN_ADDRESS` is set |
| POST | `/flare` | Pin a signal flare: `{addr, x, y, label, color?}`; free with a day pass, otherwise a 1,000 ABYS burn |
| DELETE | `/flare` | Remove one of your own flares: `{addr, index}` |
| POST | `/adopt` | Adopt a living creature: `{addr, creatureId}`; free, three per known address |
| DELETE | `/adopt` | Release an adoption: `{addr, creatureId}` |
| POST | `/cheer` | Rally for a species: `{addr, species}`; free, one vote per known address, one change a minute |
| POST | `/tick` | Debug only: 404 unless `ALLOW_DEBUG_TICK=1`; not part of the public API |
| GET | `/health` | Self-observation: the counters and what they last saw, the signals that are out of the 24-hour window as history rather than as a present failure, the snapshot and receipt budget watermarks, the state of the anchor (including what a day costs and how long the account funds it), of the data tier, and of the feed (`feed.indexedUpTo`, `feed.head`, `feed.lagBlocks`, `feed.tag` — the tag that bounds the indexed height is named in the answer, and the whole block is null when running on the offline rain). Never cached |
| GET | `/ui` | Redirects to `/` |

`OPTIONS` on any path answers 204 with permissive CORS headers; the write routes
additionally refuse a cross-origin `Origin` unless it matches the request's own
origin or appears in `CORS_ORIGINS`.

## Payment mechanics: burn-to-pay

`POST /intervene` and `POST /flare` are paid by destruction. An unpaid request
gets **HTTP 402** with one `exact` offer naming the ABYS contract and an amount
in base units:

```json
{ "error": "payment required",
  "accepts": [{ "scheme": "exact", "settle": "burn", "network": "eip155:5042",
                "asset": "0xABYS…", "amount": "100000000000000000000000" }],
  "price": "100000 ABYS", "legendary": false }
```

The wallet sends the burn itself and the client retries with the transaction
hash in `X-Payment-Tx`. The server fetches the receipt and accepts the action
only if it contains an ABYS `Transfer` to a burn sink for at least the asked
amount, and only once per hash. Both burn conventions count: a contract `burn()`
(Transfer to `0x0`) or a transfer to the blackhole `0x…dead`; the wallet uses the
latter because it works on any ERC-20. The client keeps retrying while the
receipt is still pending, so a fast wallet never reads as a failed payment.
There is no seller key, no facilitator and no custody: the tokens leave
circulation.

The order of operations is the safety property:

1. **Validate first.** The whole request is checked before any receipt is
   looked at — coordinates inside the world, a radius in 10..300, a creature
   that exists, a name of 1..24 characters, a wish of 1..60, markup stripped
   from both, no second ark ticket on one body. A rejected request costs
   nothing and leaves the burn spendable.
2. **Quote exactly.** The 402 carries the price that will actually be charged,
   legendary multiplier included.
3. **Spend last.** A receipt is recorded as used only after the paid action
   succeeded.
4. **Refund the loser.** The tank keeps ticking while a receipt is being
   verified. A targeted action whose subject died in that window — or whose ark
   ticket somebody else bought first — answers **409** with `refunded: true` and
   does *not* consume the receipt, so the payer can aim the same burn at
   somebody still swimming.

There is no demo or unpaid path. Without `ABYS_TOKEN_ADDRESS` the server still
boots and the observatory stays free to watch, but `POST /intervene` answers
**503 token not deployed** and the panel says so.

## Simulation engine notes (packages/sim)

- Toroidal 1000×1000 continuous world; all randomness comes from a seeded
  mulberry32, `Math.random` never touches the engine. The engine is fully
  chain/market-agnostic: `tick(world, { chain, market })` only receives two 0..1
  temperatures per tick.
- Genome = 9→6→4 tanh feed-forward network plus color genes. Inputs include the
  local food gradient, the nearest-conspecific vector, own energy ratio, and
  three external senses: chain temperature, its rate of change, and market
  volatility. Outputs: move angle/strength, eat urge, reproduce urge.
- **Market excitation**: market temperature scales speed (×1..2, with random
  heading jitter) and metabolism (×1..1.5); volatile markets make the whole
  arena faster, hungrier and messier.
- **Food economy**, three sources and no others: ambient plankton at
  `baseSpawnRate × (0.2 + 1.6 × chainTemp)` per tick — base 0.22, so 0.044 to
  0.396 — doubled by a paid `bloom` and zeroed by a paid `drought`; meteor
  yields from real transfers (below); and pellets bought outright by `feed` and
  `wish`. Every pellet is worth 30 energy, and the tank holds at most 260 of
  them, a cap that applies to all three sources alike.
- **Species archetypes**, read off the genome's output-layer biases: `APE`
  (radius ×1.0, metabolism ×0.6, speed ×0.9 — cheap and fecund), `WHALE` (×2.2,
  ×2.0, ×0.8), `ALGO` (×0.8, ×0.9, ×1.6 — lean and fast), `INSIDER` (×1.0 across
  the board, the flat-drive default). Archetype sets body radius, basal
  metabolism and max speed. Three guards keep the tank biodiverse: newborns
  radiate into the rarest niche when their parent's species is saturated, a
  single species holding over 80% of the population pays a metabolic dominance
  tax, and an extinct species is reseeded from the rarest one.
- **Predation**: a WHALE devours any non-WHALE creature on contact whose radius
  is under 60% of its own, taking 50% of the victim's remaining energy (the rest
  dissipates), once per hunt cooldown. Predations are recorded in the tick event
  stream.
- Energy: movement costs quadratically in strength plus a basal drain; eating
  gains energy; above a threshold a creature may spend energy to reproduce
  asexually with point-mutated offspring; at zero energy it dies.
- **Harvest** every 800 ticks (1 game hour): weakest 2% culled (rounds down, may
  be zero). **Judgment day** every 19200 ticks (1 game day): weakest 10% culled
  (at least 1). Both skip at or below `populationFloor` (15), share one cull
  routine, skip creatures holding an ark ticket, and record who they saved;
  records are typed `harvest` / `judgment`.
- Every positioned happening (predation, cull, intervention) is appended to a
  200-entry structured event ring buffer with world coordinates, exposed via
  `GET /events?since=<seq>` for frontend visualization.
- **Transaction meteors**: every sampled on-chain tx falls into the world as a
  meteor at a hash-derived landing site (deterministic across clients, see
  `txLanding`). Meteor size is `log10(usd + 1) / 5` clamped to 0..1 — $0.01 ≈
  0.13, $10 ≈ 0.21, $1k ≈ 0.6, $100k = 1.0 — and the food yield is steep in it:
  `3 × size²` pellets. So dust, which is the overwhelming majority of chain
  traffic, makes a visible streak and no plankton, while real money is a local
  boom and a whale-sized transfer is a feast. Txs over `size 0.6` also shove
  nearby creatures on impact. A **paid wish** deliberately does not use that
  formula: at its own meteor size `3 × size²` is 0.48 pellets, which would leave
  three wishes in four landing in empty water, so it drops a flat
  `WISH_PELLETS = 6` instead. `SyntheticFeed` fakes 2-5 txs per tick, calibrated
  to a live Arc poll so both modes run the same food economy (flagged
  `simulated`); `ArcUsdcFeed` indexes the real transfers — hash, size and
  payer/payee — from full blocks.
- **Hunger**: below 55% of max energy a creature stops consulting its brain and
  steers straight at the nearest plankton, always taking the bite it reaches.
  Without this the tank never *shows* scarcity and a boom would pass unnoticed.
- **Chain whales**: the observation window's top USDC addresses are embodied as
  resident leviathans swimming deterministic lanes (a pure function of the
  address plus wall-clock time, computed server-side so every viewer agrees).
  Their own transfers land at their flank instead of at a hash coordinate, and
  one big enough to guarantee plankton (`WHALE_BOOM_SIZE = 1/√3`, about $770)
  leaves a bounded `boom` attractor: creatures within 150 units turn toward the
  money and race the rest of the tank to it, while everybody else is untouched.
  A whale that has gone quiet for 3 minutes shrinks and dims. The whole-map
  swarm stays the paid `feed` intervention's signature.
- **Intervention zones**: `feed` leaves a feast attractor that steers the whole
  map toward the drop zone, and repeated feeds on one spot decay (each overlap
  multiplies the yield by 0.6, floor 4 pellets) so a wallet cannot farm a corner
  into a permanent feast; `poison` drains 2 energy/tick, makes creatures visibly
  flee the zone, and deaths inside it are logged as `poison_kill`. Killing 10 or
  more creatures in one poison triggers a local famine as backlash.
- Every creature gets a deterministic codename from its archetype and id, drawn
  from a per-species word list (a WHALE is a `MOBY`, `KRAKEN`, `LEVIATHAN`,
  `ABYSS` or `TSUNAMI`; `LEVIATHAN` is a name, not a sixth species). Codenames
  are English by design in every locale; a paid name replaces one.
- `toJSON` / `fromJSON` include the PRNG state, so a serialization round-trip
  continues on the exact same evolutionary path. Snapshots written before the
  story and paid-identity layers existed still load — unnamed, mortal, with
  empty ledgers.

## Tests and CI

277 tests on `node:test`, no test framework dependency:

| Workspace | Tests | Covers |
| --- | --- | --- |
| `@abyssal/sim` | 59 | determinism, serialization round-trip, predation, culls, biodiversity guards, meteors, wishes, paid names, gene edits, ark tickets, save/load of older snapshots |
| `@abyssal/server` | 166 | routes, pricing and the 402 quote, burn-receipt verification against an offline RPC stub, refund paths, replay of a spent receipt, payload shape, the durable wall clock behind `catchUp()`, the digest state machine (what is hashed, what a failed broadcast leaves behind, what a cold isolate inherits), the day book and its derived extinctions, the transaction pointer a confirmed day earns and the pairs a stamp refuses, a day filed from one reading of a tank that keeps living while its hash is computed, the health counters, the reason each refusal carries and their budget watermarks, the economics of the anchor (what the receipt says a day cost, what the account holds, the two readings that must name one money, the alarm that fires once rather than once per process, and the figures an unreadable balance ages rather than erases), the height the feed is willing to count up to (that it stops at the block the node calls final rather than whatever it last offered, that an answer repeating the word `finalized` is not a number, how far behind the head the published figures were computed from, that both heights outlive the isolate that read them, and that the economics beside a confirmed day is waited for rather than raced), and the two hex shapes a node answers in — a minimal quantity and a zero-padded word, which are not interchangeable in either direction — the count that says which of those answers arrived in the shape that was refused, naming the call and the bytes, and the stub that has to keep sending them the way the chain does; all of it against a stubbed JSON-RPC, plus the chain feed's heartbeat, the feed state that lets an evicted object resume instead of re-backfilling, and the venue classification: that a swap is not a machine payment however it was submitted, that only an EIP-3009 authorization counts as one, that an uncatalogued venue stays an address while a catalogued one is named, that a contract admitted to the registry on its receipts does not turn its method name into a rule, that a backfilled window reports no share rather than a share of zero, and that the rails leaderboard is ordered by use rather than by one large transaction |
| `@abyssal/web` | 52 | format/geometry helpers, dictionary completeness across all six languages, markup prices against the server's price list, the census curves, the deep-link rules and a page booted *from* a link, a pinned day's explorer link and the unstamped day that must not grow one, the standing diff behind "while you were away", the preview card against the file it names, the run list against the test files on disk, and a canvas render smoke test |

The server tests stub the chain with a local `node:http` RPC, so the suite runs
offline and never touches Arc. The web tests boot the real `app.js` inside jsdom
against a local server, which is why `@napi-rs/canvas` is there: a canvas that
cannot measure text cannot lay out a card. GitHub Actions
(`.github/workflows/ci.yml`) runs four gates on Node 22: `npm run build`,
`npm run typecheck`, an ESM syntax check over the seven client files the browser
loads, and `npm test`. The syntax gate exists because the client is
dependency-free ES modules — a stray top-level await should fail in CI rather
than in a browser.

## Status

Live in production: both views, all nine paid actions against the deployed ABYS
contract, the paid historical-data route settled in USDC, the free social layer,
six languages, and the Durable Object tank ticking on a one-minute Cron Trigger
with zero viewers.

The trust anchor is live rather than reserved: a day that closes is committed to
Arc by the key in `ARC_DIGEST_KEY`, the pre-image is a fixed published field list
anybody can recompute, and `GET /history/census` serves the book of those days —
the numbers that went on chain next to the headcount they describe, and on the days
whose transaction mined, the hash of the transaction itself so a reader can open it
and check the calldata alone. A reverted transaction is kept on the day's record as
evidence that an attempt happened and pointed at by no row: a link beside a
population says "here are the numbers, on chain", and a reverted one does not.
The bookkeeping the anchor needed outlived its first draft: `lastCommittedDay` and the
outstanding transaction moved into the ledger, because an eviction between two day
boundaries used to be able to commit the same day twice.

Whether the account that pays for it can keep paying is measured rather than
assumed. Each confirmed day is priced from its own receipt, read off the chain:
30,440 gas for day 15's transaction (`0xcc60e690…`), 30,600 for day 35's
(`0xa2c292fe…`), 30,560 for day 36's (`0x15f88c4b…`) and 30,560 again for day 37's —
the gas price that moved between them was 20.1 gwei on days 15 and 37 and 20 on the
other two, so a day costs 611,200,000,000,000 to 614,256,000,000,000 fee units,
`0.0006` of the money. The newest of those measured costs is what the balance gets
divided by: at the day-36
confirmation the account held 19,986,521,442,730,018,800 fee units, which is 32,700
anchors, five years at the ~82 minutes a day is taking (the last two rows of the
book are 81.4 and 82.0 minutes apart). Both balances are read at the moment a day
confirms — two RPC calls a day, not one per page view — and the age of the reading is
published beside the figures, so a reader can see how stale the arithmetic is
rather than assume it is current. The same read also asks the token contract
`balanceOf` for the signing address, not to divide anything with it but to
check the property every figure in the block depends on: across the 1e12 between the
chain's two decimal layers, the token balance has to be the fee balance *truncated*
at six decimals. Truncated, because the account carries dust under that boundary and
the dust does not hold still: the day-35 read above left 642,730,018,800 fee units
under the boundary and the day-36 read left 442,730,018,800, while the balance
between them moved by 611,200,000,000,000 — exactly one day's fee, and nothing about
either tail divisible by it. An exact-equality check would not have been a one-off
alarm on the day it shipped; it would have alarmed on every read since. Either half
missing is published as `scaleOk: null` rather than as a pass, and counted as
`anchor_econ_unreadable` with the bytes that caused it, because a missing answer is
exactly what this check spent its first weeks producing: a contract's padded word
was being read by a parser written for bare quantities, so the account said its
balance and the reader reported that it had not.
Below 90 anchors remaining the runway becomes a counted alarm, raised once per fall
rather than once per process.

Three edges are where they are on purpose:

- Only a *closed* day is in the day book. The row for the day in progress carries
  `committed: false`, so a chart cannot present a number that has no attestation
  behind it.
- "While you were away" is remembered in the browser that saw the last visit. It is
  a diff against a previous answer, kept in `localStorage`; the server is not told
  who looked at what, which is the reason there is no account to sync it from.
- The social preview card is one static image. Naming a creature in it would mean
  generating HTML per request, and `GET /` is served by the asset layer with the
  edge cache in front of it — the Worker never sees that request today.

**ABYS** is the project's payment asset for everything that happens *inside* the
tank: it is quoted for every intervention, it is always destroyed to pay, and there
is no discount tier and no treasury flow in the live product. USDC buys only the
historical data route, which pays a seller instead of burning — the one place in
the product where money goes somewhere rather than out of circulation. Supply and
distribution are out of scope for this repository.
