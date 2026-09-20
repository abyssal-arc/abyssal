# ABYSSAL


**Site: [abyssal-arc.com](https://abyssal-arc.com)** · token **ABYS**

A 24/7 observatory for machine payments on **Arc** (Circle's L1, mainnet
chainId **5042**, gas token **USDC**, native x402), with a living ecosystem
growing on top of the same data. Arc is the only network this build targets.
The offline `SyntheticFeed` stands in when the RPC is unreachable, or when you
ask for it with `CHAIN_FEED=synthetic`.

The name is literal. The abyssal zone (2000-6000 m) gets no sunlight, and
everything down there lives on marine snow sinking from above. This ecosystem
lives on the same thing: **x402 settlement traffic sinking from the chain**.
Every plankton pellet traces back to a real machine payment.

Two views over one data source:

- **OBSERVE**: the Arc USDC flow observatory. Live payment map, volume pulse,
  endpoint ranking, a scrolling transfer ticker, per-address drill-down. Free
  to watch.
- **WORLD**: a deterministic ecosystem driven by that same flow. Chain
  congestion sets the food spawn rate, market turbulence sets the excitation,
  and the window's biggest payers swim through the tank as whales whose own
  transfers feed the water around them.  First visit rides a causal lens: the camera follows one real transfer from
  chain to plankton to the creature that eats it. Clicking a meteor opens its
  transfer; clicking an address or a leaderboard row jumps the camera to the
  matching whale or creature.

Plus an intervention panel paid over real x402 (USDC at list price, or **ABYS**
at a ~30% discount).

> Everything in this repository is original work.

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ Browser (packages/web)                                     │
│  Canvas world / observatory / charts / cull lists / panel  │
└──────────────┬───────────────────────────────▲─────────────┘
        poll /snapshot /observe /history   POST /intervene (x402)
               │                               │
┌──────────────▼───────────────────────────────┴─────────────┐
│ packages/server  (Fetch API handler: export default fetch) │
│  routes / static hosting / PaymentVerifier / feeds         │
│  local: node:http adapter (dev.ts, brotli+gzip) → CF Worker│
└────────────────────────────┬──────────────────────────────┘
       │ tick(world, senses)  │ sample()
┌──────▼──────────────┐   ┌───▼───────────────────────────────────────┐
│ packages/sim        │   │ ChainFeed: Synthetic / ArcUsdc           │
│ zero-dep deterministic│  │ MarketFeed: arc-usdc-flow / Synthetic    │
│ engine, mulberry32  │   │                                           │
│ 9→6→4 NN genomes    │   └───────────────────────────────────────────┘
└─────────────────────┘
```

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
npm test           # sim + server unit tests
npm run typecheck  # repo-wide TypeScript type check
npm run build      # compile sim + server
```

Environment variables:

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
| `ABYS_TOKEN_ADDRESS` | unset | Deployed ABYS contract. Interventions are paid by burning ABYS; until this is set `POST /intervene` answers 503 while the observatory still runs free |
| `COMPRESS_LEVEL` | `6` | Brotli quality for response compression in the node adapter (6 ≈ 0.5–3 ms/payload; 11 costs ~570 ms on `/history`) |
| `COMPRESS_MIN_BYTES` | `1024` | Responses smaller than this are sent uncompressed |

**One world, shared.** The simulation runs server-side, so every browser sees
the same ecosystem at the same simulated instant; positions interpolate
against the server clock, not the viewer's. The world is snapshotted to
`WORLD_STATE` every `SAVE_MS` and resumed on boot, so a restart continues the
same day, the same individuals and the same lineages instead of reseeding.
Client-side ambience (nebula, stars, motes) is generated from fixed seeds for
the same reason, so a refresh never re-rolls the scenery.

**One chain, two jobs.** The observatory *reads* Arc **mainnet 5042** (the
USDC transfer flow). Interventions are paid on the same chain by **burning
ABYS**: the visitor's burn transaction is the payment, its receipt is the
proof, and nobody custodies anything. The UI badges the panel with the burn
settlement, and says "settlement unconfigured" until `ABYS_TOKEN_ADDRESS` is
set.

Tip: plain `npm run dev` already talks to the real Arc mainnet RPC. There is
no flag to flip. The Arc feed indexes the **USDC transfer flow**, which is what
powers both the observatory and the ecosystem's food economy.

The temperatures calibrate themselves by rank: every poll is scored against
the polls of the last few minutes and reported as its percentile in that
window, so there are no reference throughputs to retune when Arc's absolute
volume moves, and a single whale settlement cannot stretch the scale for
everybody else. On 5 consecutive RPC failures the server degrades to the
synthetic feed (`feedStatus: "degraded"` in `/state`) and switches back
automatically on recovery.

### Bandwidth

The node adapter compresses every text response (brotli preferred, gzip
fallback, `Vary: accept-encoding`); on Cloudflare Workers the edge does this
instead, which is why compression lives in `dev.ts` and not in the handler.
Static assets carry `ETag`/`Last-Modified`, so an unchanged reload is a 304
with an empty body. Polling is incremental: `/snapshot?since=` returns only
unseen events, `?tx=` only unseen meteors, and `/history?slots=` ships the
chart's 200 points instead of the raw 2000-tick window. A hidden tab stops
polling entirely and soft-restarts on return. Measured on Arc mainnet:
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
percentile of recent swings, so "volatile" always means volatile for this
chain this week rather than against a fixed number. Off Arc it defaults to
`SyntheticMarketFeed` (US equities session rhythm: volatile 9:30-16:00 ET,
calmer pre/after-market, near-zero on weekends). See
`packages/server/src/market.ts`.

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/` | Web frontend (index.html) |
| GET | `/api` | Endpoint index (JSON) |
| GET | `/state` | tick, day, population, chain + market temperature, harvest/judgment countdowns, payment mode |
| GET | `/world` | Render snapshot: creatures (id/name/pos/energy/color genes/archetype/kills), food, world size, chain whales |
| GET | `/snapshot` | Combined world + state + events + txRain in one request: `?since=<seq>` for unseen events, `?tail=<n>` caps the cold-start event replay, `?tx=<hash>` returns only meteors newer than that hash |
| GET | `/history` | Per-tick stats for charts: `?window=<n>` sets the depth (default and max 2000), `?slots=<n>` decimates server-side to the chart's point budget |
| GET | `/judgments` | Cull records, each tagged `type: "harvest" \| "judgment"`; filter with `?type=` |
| GET | `/events` | Positioned event stream (predation/cull/intervention) for visualization; poll with `?since=<seq>` |
| GET | `/observe` | Arc USDC flow observatory: window stats, endpoint ranking, volume pulse, recent flows (`{available:false}` off Arc) |
| GET | `/observe?addr=0x…` | One address's two-way flow inside the window plus its stats, what the address drawer opens |
| POST | `/intervene` | x402-gated intervention: USDC at list price or ABYS at a ~30% discount |
| POST | `/tick` | debug: advance one tick manually |
| GET | `/ui` | Redirects to `/` |

## Interventions and x402 payments

Four interventions (`packages/server/src/payments.ts`):

| Intervention | ABYS (burned) | Effect |
| --- | --- | --- |
| `feed` | 50,000 | Drop food in a target area |
| `poison` | 100,000 | Drain energy inside a target area (1600 ticks ≈ 6.7 min) |
| `bloom` | 200,000 | Global food spawn ×2 (2400 ticks = 10 min) |
| `drought` | 200,000 | Global food spawn halted (2400 ticks = 10 min) |

`POST /intervene` is paid by destruction. The 402 response carries one `exact`
offer naming the ABYS contract and an amount in base units; the wallet sends a
`burn(amount)` transaction to that contract and the client retries with the
transaction hash in `X-Payment-Tx`. The server fetches the receipt and accepts
the intervention only if it contains an ABYS `Transfer` to the zero address for
at least the asked amount, and only once per hash. There is no seller key, no
facilitator and no custody: the tokens leave circulation.

There is no demo or unpaid path. Without `ABYS_TOKEN_ADDRESS` the server
still boots and the observatory stays free to watch, but `POST /intervene`
answers **503 token not deployed** and the panel says so.

`packages/server/src/facilitator.ts` keeps a Circle Facilitator client
(EIP-3009 seller proofs, `/settle`, signer recovery) as a reserved path for a
future USDC-denominated product such as the paid data tier. Interventions do
not use it.

Money enters this simulation only as weather. A paid intervention changes the
environment (food, drains, spawn rates) and a chain transfer becomes plankton
at a landing site; no code path writes a payment, a price or a settlement
outcome into an individual creature's genome or brain, and the sim never pays
anybody back. There is no agent-to-agent transfer, no prediction market and no
reward stream: ABYS is only a discounted unit for buying environment
perturbations. `sim.test.ts` pins the environment-only half of that boundary.

Either way, an unpaid request gets **HTTP 402** with a body like:

```json
{ "error": "payment required",
  "accepts": [{ "scheme": "x402", "network": "arc", "chainId": 5042,
                "asset": "USDC", "tokenAddress": "0x3600…0000",
                "amount": "50000", "payTo": "0x…" }] }
```

## Simulation engine notes (packages/sim)

- Toroidal 1000×1000 continuous world; all randomness comes from a seeded
  mulberry32, `Math.random` never touches the engine. The engine is fully
  chain/market-agnostic: `tick(world, { chain, market })` only receives two
  0..1 temperatures per tick.
- Genome = 9→6→4 tanh feed-forward network + color genes. Inputs include the
  local food gradient, the nearest-conspecific vector, own energy ratio, and
  three external senses: chain temperature, its rate of change, and market
  volatility. Outputs: move angle/strength, eat urge, reproduce urge.
- **Market excitation**: market temperature scales speed (×1..2, with random
  heading jitter) and metabolism (×1..1.5), volatile markets make the whole
  arena faster, hungrier and messier.
- **Species archetypes** derived from the genome's output-layer biases:
  `APE` (cheap metabolism, breeds easily), `WHALE` (2.2× body, 2× metabolism),
  `ALGO` (1.6× speed, lean), `INSIDER` (balanced). Archetype sets body radius,
  basal metabolism and max speed. Three guards keep the tank biodiverse:
  newborns radiate into the rarest niche when their parent's species is
  saturated, a single species holding >80% of the population pays a metabolic
  dominance tax, and an extinct species is reseeded from the rarest one.
- **Predation**: a WHALE devours any non-WHALE creature on contact whose
  radius is under 60% of its own, taking 50% of the victim's remaining energy
  (the rest dissipates), once per hunt cooldown. Predations are recorded in
  the tick event stream.
- Energy: movement costs quadratically in strength plus a basal drain; eating
  gains energy; above a threshold a creature may spend energy to reproduce
  asexually with point-mutated offspring; at zero energy it dies.
- **Harvest** every 800 ticks (1 game hour): weakest 2% culled (rounds down,
  may be zero). **Judgment day** every 19200 ticks (1 game day): weakest 10%
  culled (at least 1). Both skip at or below `populationFloor` and share the
  same cull logic; records are typed `harvest` / `judgment`.
- Every positioned happening (predation, cull, intervention) is appended to a
  200-entry structured event ring buffer with world coordinates, exposed via
  `GET /events?since=<seq>` for frontend visualization.
- **Transaction meteors**: every sampled on-chain tx falls into the world as
  a meteor at a hash-derived landing site (deterministic across clients, see
  `txLanding`). The food yield is steep in dollars, `3 × size²` pellets, where
  `size` is log-scaled USDC, so dust (the overwhelming majority of chain
  traffic) makes a visible streak and no plankton, while real money is a local
  boom and a whale-sized transfer is a feast. Txs over `size 0.6` also shove
  nearby creatures on impact. `SyntheticFeed` fakes 2-5 txs per tick, calibrated
  to a live Arc poll so both modes run the same food economy (flagged
  `simulated`); `ArcUsdcFeed` indexes the real transfers, hash, size and
  payer/payee, from full blocks.
- **Hunger**: below 55% of max energy a creature stops consulting its brain and
  steers straight at the nearest plankton, always taking the bite it reaches.
  Without this the tank never *shows* scarcity, a boom would pass unnoticed.
- **Chain whales**: the observation window's top USDC addresses are embodied as
  resident leviathans swimming deterministic lanes (a pure function of the
  address plus wall-clock time, computed server-side so every viewer agrees).
  Their own transfers land at their flank instead of at a hash coordinate, and
  one big enough to guarantee plankton (`WHALE_BOOM_SIZE`, ~$770) leaves a
  bounded `boom` attractor: creatures within 150 units turn toward the money
  and race the rest of the tank to it, while everybody else is untouched. A
  whale that has gone quiet for 3 minutes shrinks and dims. The whole-map swarm
  stays the paid `feed` intervention's signature.
- **Intervention zones**: `feed` leaves a feast attractor that steers the
  whole map toward the drop zone; `poison` drains 2 energy/tick, makes
  creatures visibly flee the zone, and deaths inside it are logged as
  `poison_kill`.
- Every creature gets a deterministic codename from its archetype + id
  (e.g. `MOBY-042`, `DART-117`); names are English by design everywhere.
- `toJSON` / `fromJSON` include the PRNG state, so a serialization round-trip
  continues on the exact same evolutionary path (covered by tests).

## Road to mainnet

1. **Token**: deploy the ABYS ERC-20 with `burn(uint256)` emitting
   `Transfer(from, 0x0)`, then export `ABYS_TOKEN_ADDRESS`.
2. **Data tier**: price the historical API in USDC through the reserved Circle
   facilitator path, keeping interventions on burn-to-pay.
3. **Trust anchor**: commit the daily world-summary digest on chain so anyone
   can verify the operator didn't rig the simulation (task tracked in
   `TOKEN_PLAN.md`; it is a public attestation, not a distribution mechanism).
4. **History**: time-travel the observatory (1h/24h pulse history with range
   brushing) behind the paid tier.
5. **Deployment**: move the Fetch handler to Cloudflare Workers (static assets
   via Workers Static Assets replacing `static.ts`; world state driven by a
   Durable Object alarm).
6. **Frontend**: wallet UX for the paid data tier (historical API, exports,
   subscriptions); the live observatory stays free.

## Token

**ABYS** is the project's payment and discount asset: interventions and the
paid data tier are quoted in USDC at list price and in ABYS at a ~30% discount.
Supply, distribution and auction mechanics are designed in `TOKEN_PLAN.md` and
are deliberately not restated here.
