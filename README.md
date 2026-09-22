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
  with 1h/24h time-travel, endpoint ranking, a scrolling transfer ticker,
  per-address drill-down. Free to watch.
- **WORLD** — a deterministic ecosystem driven by that same flow. Chain
  congestion sets the food spawn rate, market turbulence sets the excitation,
  and the window's biggest payers swim through the tank as whales whose own
  transfers feed the water around them. First visit rides a causal lens: the
  camera follows one real transfer from chain to plankton to the creature that
  eats it. Clicking a meteor opens its transfer; clicking an address or a
  leaderboard row jumps the camera to the matching whale or creature.

What a visitor can *do* splits in two: a free social layer — adopt, rally,
lineage, the fossil wall — and ten paid actions, each settled by **burning
ABYS**. The burn receipt is the payment, nobody custodies anything, and the
tokens leave circulation.

The interface ships in six languages — English, Français, Deutsch, 中文,
日本語, 한국어 — from a hand-written dictionary in `packages/web/i18n.js`
(314 keys per language, kept in step by a test).

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

`packages/server/src/facilitator.ts` keeps a Circle Facilitator client
(EIP-3009 seller proofs, `/settle`, signer recovery) as a reserved path for a
future USDC-denominated product. Nothing in the live product calls it: every
paid action settles by burning ABYS.

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
npm test           # sim + server + web tests (106 total)
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
| `ARC_RPC_URL` | `https://rpc.mainnet.arc.io` | Arc JSON-RPC endpoint (used when `CHAIN_FEED=arc`) |
| `ARC_USDC_ADDRESS` | `0x3600…0000` | Native USDC precompile on Arc |
| `EXPLORER_TX_URL` | `https://explorer.arc.io/tx/` | Explorer base URL for tx links |
| `ABYS_TOKEN_ADDRESS` | unset locally; set in `wrangler.toml` `[vars]` for production | The deployed ABYS contract. Until it is set, `POST /intervene` answers 503 while the observatory still runs free |
| `ARC_DIGEST_KEY` | unset | Signing key for the daily digest. Unset, the digest is still computed and served but never committed on chain. `/state` reports `digestChain: null` until a day rolls inside the object, then `digestChain.status: "unconfigured"` |
| `USED_BURNS_FILE` | `.data/used-burns.txt` | Append-only log of spent burn receipts, so a restart cannot replay an old burn |
| `COMPRESS_LEVEL` | `6` | Brotli quality in the node adapter (6 ≈ 0.5–3 ms/payload; 11 costs ~570 ms on `/history`) |
| `COMPRESS_MIN_BYTES` | `1024` | Responses smaller than this are sent uncompressed |
| `CORS_ORIGINS` | empty | Comma-separated extra origins allowed to post. Not needed for the deployed site, which is same-origin with itself |
| `ALLOW_DEBUG_TICK` | unset | `POST /tick` answers 404 unless this is `1` |
| `FACILITATOR_URL`, `SELLER_PRIVATE_KEY`, `SELLER_PAY_TO`, `X402_TESTNET` | unset | Reserved Circle Facilitator path. No live route reads them |

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
creatures, the day anchor) is durable and survives eviction; the chain telemetry
around it does not. `feedStatus`, `chainTemp`, `chainDelta`, `marketTemp` and
`blockNumber` are only ever written inside `advance()`, and a request that lands
on a freshly booted object is served before any advance has run — `catchUp()`
returns early because nothing has elapsed yet. Such a request reports the
boot-time initializers: `feedStatus: "synthetic"`, both temperatures pinned at
`0.5`, and no `blockNumber` field at all. That is *not* evidence the Arc feed is
off; `chainFeed: "arc-usdc"` and `marketFeed: "arc-usdc-flow"` in the same
payload say the real feeds are wired. The tell is that a cold reading never
carries a `blockNumber`. The cron keeps the object warm, so in practice the
window is short — but a single cold reading proves nothing either way.

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
| GET | `/judgments` | Cull records, each tagged `type: "harvest" \| "judgment"`; filter with `?type=` |
| GET | `/events` | Positioned event stream (predation/cull/intervention) for visualization; poll with `?since=<seq>` |
| GET | `/reports` | Battle reports for paid interventions, scored 400 ticks after the burn |
| GET | `/lineage` | Family tree of one creature: `?id=<n>&depth=<n>` returns ancestors and descendants |
| GET | `/hall-of-fame` | The fossil wall: all-time top five per category |
| GET | `/who?addr=0x…` | One address in the tank: burns, badges, day pass, board rank, its own battle reports |
| GET | `/observe` | Arc USDC flow observatory: window stats, endpoint ranking, volume pulse, recent flows (`{available:false}` off Arc) |
| GET | `/observe?addr=0x…` | One address's two-way flow inside the window plus its stats, what the address drawer opens |
| GET | `/export?pass=0x…&kind=` | Day-pass download of the observation window: `csv`, `replay` or `digest` |
| POST | `/intervene` | One of nine interventions, gated on an ABYS burn receipt; 503 until `ABYS_TOKEN_ADDRESS` is set |
| POST | `/flare` | Pin a signal flare: `{addr, x, y, label, color?}`; free with a day pass, otherwise a 1,000 ABYS burn |
| DELETE | `/flare` | Remove one of your own flares: `{addr, index}` |
| POST | `/adopt` | Adopt a living creature: `{addr, creatureId}`; free, three per known address |
| DELETE | `/adopt` | Release an adoption: `{addr, creatureId}` |
| POST | `/cheer` | Rally for a species: `{addr, species}`; free, one vote per known address, one change a minute |
| POST | `/tick` | Debug only: 404 unless `ALLOW_DEBUG_TICK=1`; not part of the public API |
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

106 tests on `node:test`, no test framework dependency:

| Workspace | Tests | Covers |
| --- | --- | --- |
| `@abyssal/sim` | 54 | determinism, serialization round-trip, predation, culls, biodiversity guards, meteors, wishes, paid names, gene edits, ark tickets, save/load of older snapshots |
| `@abyssal/server` | 44 | routes, pricing and the 402 quote, burn-receipt verification against an offline RPC stub, refund paths, payload shape, the durable wall clock behind `catchUp()` |
| `@abyssal/web` | 8 | format/geometry helpers, dictionary completeness across all six languages, markup prices against the server's price list, a canvas render smoke test |

The server tests stub the chain with a local `node:http` RPC, so the suite runs
offline and never touches Arc. GitHub Actions (`.github/workflows/ci.yml`) runs
four gates on Node 22: `npm run build`, `npm run typecheck`, an ESM syntax check
over the four web modules, and `npm test`. The syntax gate exists because the
client is dependency-free ES modules — a stray top-level await should fail in CI
rather than in a browser.

## Status

Live in production: both views, all ten paid actions against the deployed ABYS
contract, the free social layer, six languages, and the Durable Object tank
ticking on a one-minute Cron Trigger with zero viewers.

Still open:

- **Trust anchor.** The daily world digest is computed, served and exported, but
  not committed on chain: production runs without `ARC_DIGEST_KEY`, so the
  commit path stops at `status: "unconfigured"` and never signs. Until a key is
  set, "the operator didn't rig the simulation" rests on determinism and the
  published seed rather than on an attestation anybody can verify
  independently. Setting one needs more than the secret: `lastCommittedDay`
  lives in the isolate too, so an eviction between two day boundaries would
  commit the same day twice. That bookkeeping has to become durable first.
- **Paid data tier.** `facilitator.ts` is complete and unused. Historical API
  access in USDC would be its first product; today the only paid data is the day
  pass, which burns ABYS.

**ABYS** is the project's payment asset and nothing else: it is quoted for every
paid action, it is always destroyed to pay, and there is no discount tier, no
USDC alternative and no treasury flow in the live product. Supply and
distribution are out of scope for this repository.
