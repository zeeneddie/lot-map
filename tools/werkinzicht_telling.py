#!/usr/bin/env python3
"""Weektelling askWhy (AW1) tegen de criteria van AW2.

Leest ~/.mq/werkinzicht/askwhy/*.json (één bestand per sessie, door de lot-map-fork geschreven bij het
einde van de sessie: alleen tellingen en namen) en ~/.mq/werkinzicht/nut.md (één regel per geval waarin
de reden hielp, door Eddie bijgehouden). Geeft per criterium de waarde en of de drempel gehaald is.

    python3 tools/werkinzicht_telling.py                       # alles
    python3 tools/werkinzicht_telling.py --van 2026-11-12 --tot 2026-11-26
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

DREMPEL_DEKKING = 0.80  # (a) aandeel aanroepen met een Waarom:-regel
DREMPEL_NUT_PER_WEEK = 3  # (c) gevallen per week waarin de reden hielp
DREMPEL_KOSTEN = 0.02  # (d) tekens in Waarom:-regels t.o.v. alle zichtbare tekst


def lees(map_: Path, van: str | None, tot: str | None) -> list[dict]:
    rijen = []
    for p in sorted(map_.glob("*.json")):
        try:
            r = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as fout:
            print(f"  overgeslagen (onleesbaar): {p.name} — {fout}", file=sys.stderr)
            continue
        datum = str(r.get("date", ""))
        if (van and datum < van) or (tot and datum > tot):
            continue
        rijen.append(r)
    return rijen


def nut_gevallen(pad: Path, van: str | None, tot: str | None) -> int:
    """Regels in nut.md die met een datum beginnen (JJJJ-MM-DD …) binnen de periode."""
    if not pad.exists():
        return 0
    n = 0
    for regel in pad.read_text(encoding="utf-8").splitlines():
        datum = regel.strip().lstrip("-* ").split(" ", 1)[0]
        if len(datum) != 10 or datum[4] != "-":
            continue
        if (van and datum < van) or (tot and datum > tot):
            continue
        n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--map", type=Path, default=Path.home() / ".mq" / "werkinzicht")
    ap.add_argument("--van")
    ap.add_argument("--tot")
    a = ap.parse_args()

    rijen = lees(a.map / "askwhy", a.van, a.tot)
    if not rijen:
        print("Geen sessies gevonden in de periode — niets te beoordelen (niet gemeten is geen nul).")
        return 1

    som = lambda k: sum(int(r.get(k, 0)) for r in rijen)  # noqa: E731
    calls, stated, statedc, source, nowhere, tekst = (som(k) for k in ("calls", "stated", "statedChars", "source", "nowhere", "textChars"))
    met_askwhy = sum(1 for r in rijen if r.get("askWhy"))
    dagen = sorted({str(r.get("date")) for r in rijen})
    eerste, laatste = (date.fromisoformat(d) for d in (dagen[0], dagen[-1]))
    weken = max(1.0, ((laatste - eerste).days + 1) / 7)
    nut = nut_gevallen(a.map / "nut.md", a.van, a.tot)

    dekking = stated / calls if calls else None
    kosten = statedc / tekst if tekst else None
    print(f"Periode: {dagen[0]} … {dagen[-1]} · sessies {len(rijen)} (met askWhy aan: {met_askwhy}) · repo's: {', '.join(sorted({str(r.get('repo')) for r in rijen}))}")
    print(f"Skill/Agent/Workflow-aanroepen: {calls}")

    def regel(naam: str, waarde: str, ok: bool | None) -> None:
        teken = "—" if ok is None else ("✔" if ok else "✘")
        print(f"  {teken} {naam}: {waarde}")

    regel("(a) dekking", f"{stated}/{calls} = {dekking:.0%} (drempel {DREMPEL_DEKKING:.0%})" if dekking is not None else "geen aanroepen", None if dekking is None else dekking >= DREMPEL_DEKKING)
    regel("(b) bron", f"genoemd in prompt/regels {source} · nergens genoemd {nowhere} (geen drempel)", None)
    regel("(c) nut", f"{nut} gevallen in ±{weken:.1f} week (drempel {DREMPEL_NUT_PER_WEEK}/week)", nut / weken >= DREMPEL_NUT_PER_WEEK)
    regel("(d) kosten", f"{statedc} van {tekst} tekens = {kosten:.1%} (drempel ≤ {DREMPEL_KOSTEN:.0%})" if kosten is not None else "geen tekst gemeten", None if kosten is None else kosten <= DREMPEL_KOSTEN)
    print("  — (e) geen schade: niet uit deze telling; nagaan in de pane (hookduur) en de tests van de fork")
    return 0


if __name__ == "__main__":
    sys.exit(main())
