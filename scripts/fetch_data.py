#!/usr/bin/env python3
"""Fetch FIFA World Cup data from football-data.org and write it into data/*.json.

The site is fully static and reads the JSON files this script produces. The
script is intentionally defensive: if the API is unreachable or returns an
error, the existing data files are left untouched and meta.json records the
failure so the dashboard can show a "stale data" notice instead of going blank.

Requires the FOOTBALL_DATA_API_KEY environment variable (a free token from
https://www.football-data.org/). Without it the script exits cleanly and the
previously committed data is kept.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

API_BASE = "https://api.football-data.org/v4"
COMPETITION = "WC"  # FIFA World Cup

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def api_get(path: str, token: str) -> dict:
    url = f"{API_BASE}{path}"
    req = urllib.request.Request(url, headers={"X-Auth-Token": token})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _group_suffix(code: str) -> str:
    """Extract the part after 'Group'/'GROUP_', e.g. 'GROUP_A' or 'Group A' -> 'A'."""
    c = code.strip()
    if c.lower().startswith("group"):
        c = c[len("group"):]
    return c.strip(" _").replace("_", " ").title()


def group_label(code: str | None) -> str | None:
    """Normalise either 'GROUP_A' or 'Group A' to 'Group A'."""
    if not code:
        return None
    return f"Group {_group_suffix(code)}".strip()


def group_short(code: str | None) -> str | None:
    if not code:
        return None
    return _group_suffix(code)


def team_obj(team: dict | None) -> dict:
    team = team or {}
    return {
        "id": team.get("id"),
        "name": team.get("name") or team.get("shortName") or "TBD",
        "tla": team.get("tla"),
        "crest": team.get("crest"),
    }


def transform_standings(raw: dict) -> dict:
    groups = []
    for entry in raw.get("standings", []):
        # Group stage tables come with type == "TOTAL" and a group code.
        if entry.get("type") != "TOTAL":
            continue
        code = entry.get("group")
        if not code:
            continue
        table = []
        for row in entry.get("table", []):
            t = team_obj(row.get("team"))
            table.append({
                "position": row.get("position"),
                "team": t["name"],
                "tla": t.get("tla"),
                "crest": t.get("crest"),
                "playedGames": row.get("playedGames", 0),
                "won": row.get("won", 0),
                "draw": row.get("draw", 0),
                "lost": row.get("lost", 0),
                "goalsFor": row.get("goalsFor", 0),
                "goalsAgainst": row.get("goalsAgainst", 0),
                "goalDifference": row.get("goalDifference", 0),
                "points": row.get("points", 0),
                "form": row.get("form"),
            })
        groups.append({
            "code": code,
            "name": group_label(code),
            "short": group_short(code),
            "standings": table,
        })
    groups.sort(key=lambda g: g["code"])
    return {"groups": groups}


def transform_matches(raw: dict) -> dict:
    matches = []
    for m in raw.get("matches", []):
        score = m.get("score") or {}
        full = score.get("fullTime") or {}
        matches.append({
            "id": m.get("id"),
            "utcDate": m.get("utcDate"),
            "status": m.get("status"),
            "stage": m.get("stage"),
            "group": m.get("group"),
            "groupName": group_label(m.get("group")),
            "matchday": m.get("matchday"),
            "home": team_obj(m.get("homeTeam")),
            "away": team_obj(m.get("awayTeam")),
            "score": {"home": full.get("home"), "away": full.get("away")},
            "winner": score.get("winner"),
        })
    matches.sort(key=lambda x: (x.get("utcDate") or "", x.get("id") or 0))
    return {"matches": matches}


def write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def write_meta(ok: bool, note: str, competition: str = "FIFA World Cup", season: str = "2026") -> None:
    write_json(DATA_DIR / "meta.json", {
        "updated": now_iso(),
        "competition": competition,
        "season": season,
        "source": "football-data.org",
        "ok": ok,
        "note": note,
    })


def main() -> int:
    token = os.environ.get("FOOTBALL_DATA_API_KEY", "").strip()
    if not token:
        msg = "FOOTBALL_DATA_API_KEY not set; keeping existing data."
        print(msg, file=sys.stderr)
        write_meta(False, msg)
        return 0

    try:
        standings_raw = api_get(f"/competitions/{COMPETITION}/standings", token)
        matches_raw = api_get(f"/competitions/{COMPETITION}/matches", token)
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8")[:300]
        except Exception:
            pass
        msg = f"API HTTP {e.code}: {body}".strip()
        print(msg, file=sys.stderr)
        write_meta(False, msg)
        return 0
    except Exception as e:  # network errors etc.
        msg = f"Fetch failed: {e}"
        print(msg, file=sys.stderr)
        write_meta(False, msg)
        return 0

    comp = (matches_raw.get("competition") or {})
    season = (matches_raw.get("filters") or {}).get("season") or "2026"

    standings = transform_standings(standings_raw)
    matches = transform_matches(matches_raw)

    write_json(DATA_DIR / "standings.json", standings)
    write_json(DATA_DIR / "matches.json", matches)
    write_meta(
        True,
        f"{len(standings['groups'])} groups, {len(matches['matches'])} matches",
        competition=comp.get("name") or "FIFA World Cup",
        season=str(season),
    )
    print(f"Wrote {len(standings['groups'])} groups and {len(matches['matches'])} matches.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
