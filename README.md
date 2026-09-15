pons — Pons v2 launchpad research pipeline
Indexes every launch on the Pons v2 launchpad (Robinhood Chain, chain ID 4663)directly from the blockchain — no scraping, no APIs in the trust path — then profileswhat the highest-earning tokens have in common.

Runs itself hourly on GitHub Actions. Costs $0.

What it collects
For every token ever launched through the factory:

Metadata — name, symbol, logo, description, twitter/telegram/discord/website/farcaster,creator tax, fee wallet, pair token, snipe-tax exemptions (decoded from the launchtransaction input)
Trading — every curve buy/sell (quote + token amounts, fees, tax), volumes,per-minute early volume, price path, unique buyers/sellers
Creator earnings, exact — swept + rescued + pending, curve-side and post-graduationhook-side (FeesSwept, FeesRescued, PoolFeesSwept, PoolFeesRescued + on-chainpending-balance probes), plus buyback-and-lock value as creator comp
Windows — fees generated and credited in the first 1h / 24h vs all-time
War telemetry — snipe tax charged, sniper wallets, declared exemptions
Lifecycle — graduation, V4 pool id, phase, buyback enablement
Data sources are the verified contracts themselves: PonsV2LaunchFactory,PonsV2BondingCurve, PonsV2LauncherToken, PonsV2MemeHook — exact eventsignatures and ABI reads, no guesswork.

How it works
GitHub Actions (hourly)
├─ pons-index.mjs → chain → pons_data/pons_launches.jsonl (one row per token)
└─ commits the data back to this repo

You (anywhere, takes seconds)
└─ pons-profile.mjs → ranks by creator earnings for ANY window/slice,
then mechanically mines the top slice: every letter, word, length bucket,
tax bucket, boolean and pair-combo → "% of winners vs % of the rest",
with lift and p-values

text


## Using the profiler

```bash
git pull                                   # get the freshest data

node pons-profile.mjs --top 10             # all-time top 10, with full math stories
PCTS=0.1,1,5,10 node pons-profile.mjs      # mine several slices at once
WINDOW=1h  TOP_PCT=5 node pons-profile.mjs # first-HOUR champions
WINDOW=24h TOP_PCT=1 node pons-profile.mjs # first-day performers
node pons-profile.mjs --explain 0xTOKEN    # one token's complete decomposition
Outputs land in pons_data/:

File
What it is
pons_launches.jsonl	the dataset — one line per launch, everything above
pons_recipe_all.md	the spec card: what all-time winners have, set these values
pons_recipe_1h.md	same, for first-hour winners
pons_traits.csv	every trait tested, every slice: winners% / rest% / lift / p
progress.json	indexer health: block cursor, %, launches found

Reading the results honestly
winners% only means something next to rest% — a 90%-vs-88% trait is decoration
act only on traits with lift ≥ 1.3 and p below the Bonferroni line printed per run
snipe tax (99% → 0 over the first 3s) suppresses minute-one volume by design
letters/words are correlational and rotate; the meta drifts — re-run and diff
correlation ≠ causation: validate by launching and re-measuring with this same pipeline
Repo layout
text

pons-index.mjs        chain → dataset (crash-safe, resumable, multi-RPC w/ rate learner)
pons-profile.mjs      dataset → rankings, trait mining, spec cards
.github/workflows/    hourly automation
pons_data/            the data + outputs (committed every run)
Notes
Read-only. No keys, no wallets, nothing transacts.
RPC endpoints live in repo secrets; the indexer rate-learns each one (AIMD)
and auto-shrinks log ranges around provider caps.
Not affiliated with Pons or Robinhood. Public-chain data, public source.
