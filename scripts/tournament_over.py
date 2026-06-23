#!/usr/bin/env python3
"""Decide whether the World Cup is definitively over.

Prints a single line:
  - "STOP"        -> the tournament is complete; the scheduled workflow may be disabled.
  - "KEEP: <why>" -> keep running.

Deliberately conservative so the cron never stops early. STOP requires ALL of:
  1. A FINAL match is present and FINISHED/AWARDED.
  2. At least BUFFER time has elapsed since the final's kickoff (covers late
     score corrections / status flips).
  3. The dataset looks complete (>= MIN_MATCHES), so a partial or empty API
     response can never trigger a premature shutdown.
"""

import json
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FINISHED = {"FINISHED", "AWARDED"}
BUFFER = timedelta(days=2)
MIN_MATCHES = 100  # the 2026 tournament has 104 matches


def decide() -> str:
    try:
        matches = json.loads((ROOT / "data" / "matches.json").read_text())["matches"]
    except Exception as e:
        return f"KEEP: cannot read matches.json ({e})"

    if len(matches) < MIN_MATCHES:
        return f"KEEP: only {len(matches)} matches in data (looks partial)"

    finals = [m for m in matches if m.get("stage") == "FINAL"]
    if not finals:
        return "KEEP: no FINAL match present yet"

    final = finals[0]
    if final.get("status") not in FINISHED:
        return f"KEEP: final is not finished (status={final.get('status')})"

    final_date = final.get("utcDate")
    if not final_date:
        return "KEEP: final has no date yet"
    try:
        final_dt = datetime.fromisoformat(final_date.replace("Z", "+00:00"))
    except Exception:
        return f"KEEP: cannot parse final date ({final_date})"

    remaining = final_dt + BUFFER - datetime.now(timezone.utc)
    if remaining > timedelta(0):
        return f"KEEP: within {BUFFER.days}-day buffer after final (~{remaining} left)"

    return "STOP"


if __name__ == "__main__":
    print(decide())
