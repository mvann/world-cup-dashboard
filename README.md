# World Cup 2026 Dashboard

A static GitHub Pages dashboard for the FIFA World Cup. It shows:

- **Groups** — live standings table for every group (top two highlighted as qualifying).
- **Calendar** — the full match schedule grouped by day, with live indicators, kickoff times and final scores. Filter by Live / Today / Upcoming / Results.
- **Bracket** — the knockout bracket, rendered as an empty skeleton from the start and filled in automatically as teams earn their placements. Crowns a champion once the final is decided.

Data is fetched from [football-data.org](https://www.football-data.org/) by a GitHub Actions workflow that runs **every 10 minutes**, commits the refreshed JSON, and redeploys the site. An open browser tab also re-polls the data once a minute.

## How it works

```
index.html          # page shell + tabs
assets/style.css     # styling
assets/app.js        # renders standings, schedule and bracket from data/*.json
data/standings.json  # group tables        (written by the workflow)
data/matches.json    # all fixtures/results (written by the workflow)
data/meta.json       # last-updated + status
scripts/fetch_data.py        # pulls from football-data.org and writes data/*.json
.github/workflows/update.yml # cron + deploy
```

The site is 100% static — no build step. `app.js` just reads the three JSON files in `data/`.

## One-time setup

1. **Get a free API key** at <https://www.football-data.org/client/register>. The free tier covers the World Cup competition and is well within rate limits at one fetch / 10 min.

2. **Add it as a repository secret** named `FOOTBALL_DATA_API_KEY`:
   `Settings → Secrets and variables → Actions → New repository secret`.

3. **Enable GitHub Pages with the Actions source**:
   `Settings → Pages → Build and deployment → Source: GitHub Actions`.

4. The workflow runs on the **default branch** (`main`). Scheduled (cron) workflows only fire from the default branch, so make sure this lives on `main`. You can trigger the first run manually from `Actions → Update & Deploy Dashboard → Run workflow`.

The site will be published at:

```
https://<your-username>.github.io/world-cup-dashboard/
```

## Behaviour without a key / on failure

If `FOOTBALL_DATA_API_KEY` is missing or the API call fails, the fetch script leaves the existing `data/*.json` untouched and records the problem in `meta.json`. The dashboard then shows the last good data with a "stale" indicator instead of going blank.

## Local preview

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

To populate real data locally:

```bash
export FOOTBALL_DATA_API_KEY=your_token
python3 scripts/fetch_data.py
```
