# EWC Club Championship simulator

Static Monte Carlo simulator served at **2easy.gg/ewc-simulator** from this folder (the repo's Vercel deploy; rewrites in
the root `vercel.json`). No build step, no backend. Pages use `<base href="/ewc-simulator/">`.

## The workbook is canonical

`EWC_Simulator_Data.xlsx` is the source of truth; `data.json` is a committed view of it.

- `python tools/extract_workbook.py` regenerates `data.json` (needs `openpyxl`). `--check` validates without writing.
  It exits non-zero unless substituting **actual placements** for the draw reproduces every club's official CC total
  (CC Reconciliation tab, 154 clubs) — that is the integrity check on the extraction.
- Title tab headers (row 6) are authoritative for seed method and TVI; the Seed Methodology "proposed" table is not.
- Not in the workbook, so carried across re-extractions from the existing `data.json`: `calibration.approved`
  (which titles have an approved TVI) and `investment`. Everything else is regenerated.
- Club names are standardised to the Clubs tab Display Name via `CANONICAL_MERGES` in the extractor (approved list).
  Brands such as Falcons Vega / Riyadh Falcons resolve to their parent club in the tabs' canonical column.
  HavoK by Vitality and Ekletyc are separate, normal clubs (not in official standings; they shift lower published ranks).
- The admin panel (`/ewc-simulator/admin`) edits a working copy of `data.json` and exports it. Structural edits made
  there must be mirrored into the workbook or the next extraction overwrites them.
- `data.json` is immutable at runtime (deep-frozen). Session experiments never mutate it.

## Architecture (keep these boundaries)

- `js/engine.js` — pure, no DOM. **Receives finished per-entry weights and never computes them.** No seed, tier,
  TVI, temperature, span or ladder logic, and no cross-title normalisation (a test greps for this). Per run, per title:
  Plackett-Luce draw (weighted sampling without replacement, implemented as Gumbel-max: `log w + Gumbel`, sort desc);
  score positions on the title's points curve; voided entries score 0 wherever they finish; placeholder entrants
  (`(no club)`, `Mixed`, …) occupy places but never score; each club keeps its **best entry per title (MAX)** and the
  lower entries' points go to nobody; sum across titles; rank; aggregate exact-rank histograms, points histograms and
  win routes per placement bucket.
- `js/calibration.js` — the only place strength weights are produced, upstream of the engine:
  `weight = base ^ (1/T)`, `T = TVI / 50`; `base = 1/seed` (methods A/B/C), the title's own tier table value (D;
  default 3 / 1 / 0.4, tab values where the tab defines them), `1` (E and session "Random").
  Tier-only entries in ranked titles (SF6 unranked players) use `1/midpoint` of their tier band, bands tiling after the
  numeric seeds High→Medium→Low. Do not add shared span constants or ladder shapes.
- **TVI**: only approved titles use their TVI (at v1 only CS2, TVI 52 — final, do not recalibrate). Every other title
  runs on the provisional TVI 50 and every output shows approved / provisional / session provenance.
  A session TVI slider re-tempers the supplied base weights; it has no effect on equal weights (Random, method E).
- `js/stats.js` — read-only views over one result. Main table, summary, club focus and investment all read the same
  run, so they cannot disagree (tested).
- `js/worker.js` runs the engine; `js/app.js` is the UI; `js/state.js` holds session overrides (URL hash, defaults
  stripped); `js/investment.js` is optional post-processing only; `js/validate.js` + `js/admin.js` are the admin side.

## Ranking and ties (official EWC 2026 rules)

Rank by CC points. On equal points, clubs eligible for the Club Championship (non-void top-8 finishes in ≥2 titles)
rank above ineligible ones. 1st goes to the highest-points club that is eligible **and** has a title win; a tie there is
broken by Olympic medal logic (compare best single results, then next best…); anything still tied shares 1st. All other
ties share the rank (competition ranking: Team Spirit and Virtus.pro are both "6="). Never random. Source:
esportsworldcup.com/en/rules-and-regulations. The published table lists tied clubs sequentially; the engine's shared rank
equals the first position of that group.

## Presentation rule

Never show a per-title expected-points figure — it is not an attainable outcome. Per-title results are probabilities
over the curve's attainable tiers (e.g. 1000/750/500/300/200/0) with the actual tier highlighted. Club totals are sums,
so means and P10/P90 are fine there. Investment figures always carry their confidence label.

## Commands

- Tests: `node --test tests/*.test.js` (Node may need its full path: `"C:\Program Files\nodejs\node.exe"`).
- Local preview: repo-root static server (`.claude/launch.json` → `2easy-static`, port 3000) → `/ewc-simulator/`.
- Admin password: SHA-256 constant in `js/admin.js` (client-side gate only).
