#!/usr/bin/env python3
"""Independent read-only audit of a curated revenue research JSON export.

No database access, credentials, embedded business data, or application writes.
Outputs contain private business data and must not be committed to version control.
Usage: python3 scripts/research/validate-revenue.py DATASET_JSON OUTPUT_DIR
"""

from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import hashlib
import itertools
import json
import math
from pathlib import Path
import random
import re
from decimal import Decimal, ROUND_HALF_UP


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def number(value):
    return Decimal(str(value))


def days_between(a, b):
    return (b - a).total_seconds() / 86400


def period_metrics(periods, start, end, *, strict=False, exclude_suspect=False):
    """Rate over observed closed periods, never over unobserved trailing days."""
    revenue = games = support = 0.0
    ids, crossing_ids = [], []
    for row in periods:
        if exclude_suspect and row["suspect_first_interval"]:
            continue
        a, b = row["start"], row["end"]
        if strict and (a < start or b > end):
            continue
        lo, hi = max(a, start), min(b, end)
        if hi <= lo or row["days"] <= 0:
            continue
        overlap = days_between(lo, hi)
        support += overlap
        revenue += row["revenue"] * overlap / row["days"]
        games += row["games"] * overlap / row["days"]
        ids.append(row["id"])
        if a < start or b > end:
            crossing_ids.append(row["id"])
    return {
        "revenue": revenue,
        "games": games,
        "days": support,
        "coverage": support / days_between(start, end),
        "rate": revenue / support if support else None,
        "games_rate": games / support if support else None,
        "period_count": len(ids),
        "period_ids": ids,
        "crossing_ids": crossing_ids,
    }


def rank_permutation_pvalue(earlier, later):
    """One-sided rank permutation on independent closed periods (exploratory).

    Rejecting exchangeability is not a causal claim. Temporal dependence remains
    a limitation. Interpolated calendar days never become independent samples.
    """
    values = earlier + later
    n = len(earlier)
    ranks = [0.0] * len(values)
    ordered = sorted(range(len(values)), key=lambda i: values[i])
    lo = 0
    while lo < len(values):
        hi = lo + 1
        while hi < len(values) and values[ordered[hi]] == values[ordered[lo]]:
            hi += 1
        for k in range(lo, hi):
            ranks[ordered[k]] = (lo + 1 + hi) / 2
        lo = hi
    observed = sum(ranks[:n])
    combinations = math.comb(len(values), n)
    exact = combinations <= 50000
    if exact:
        samples = itertools.combinations(range(len(values)), n)
        denominator, count = combinations, 0
    else:
        rng = random.Random(20461124)
        denominator, count = 10001, 1
        samples = (rng.sample(range(len(values)), n) for _ in range(10000))
    count += sum(sum(ranks[k] for k in choice) >= observed - 1e-10 for choice in samples)
    return count / denominator, exact


def bh_adjust(tests):
    """Benjamini-Hochberg correction across the entire eligible machine family."""
    ordered = sorted(tests, key=lambda r: r["p"])
    previous = 1.0
    for i in range(len(ordered) - 1, -1, -1):
        previous = min(previous, ordered[i]["p"] * len(ordered) / (i + 1))
        ordered[i]["q_bh"] = previous


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--end", help="Exclusive analysis cutoff; default is the last complete local midnight")
    args = parser.parse_args()
    raw = args.dataset.read_bytes()
    dataset = json.loads(raw)
    cutoff = timestamp(args.end) if args.end else timestamp(dataset["snapshot_reference"]).replace(hour=0, minute=0, second=0, microsecond=0)
    sep = dt.datetime(cutoff.year, 9, 1, tzinfo=cutoff.tzinfo)
    oct1 = dt.datetime(cutoff.year, 10, 1, tzinfo=cutoff.tzinfo)
    nov1 = dt.datetime(cutoff.year, 11, 1, tzinfo=cutoff.tzinfo)
    if cutoff <= nov1:
        raise ValueError("This September-to-November audit requires a cutoff after November 1")
    args.output.mkdir(parents=True, exist_ok=True)
    placements = {p["id"]: p for p in dataset["placements"]}
    by_placement = collections.defaultdict(list)
    for row in dataset["services"]:
        by_placement[row["placement_id"]].append(row)
    for rows in by_placement.values():
        rows.sort(key=lambda r: (timestamp(r["occurred_at"]), r["id"]))

    by_machine_placements = collections.defaultdict(list)
    for placement in placements.values():
        by_machine_placements[placement["machine_number"]].append(placement)
    transitions, suspect_placements = [], set()
    for machine, chain in by_machine_placements.items():
        chain.sort(key=lambda r: (timestamp(r["started_at"]), r["id"]))
        for previous, current in zip(chain, chain[1:]):
            if timestamp(current["started_at"]) < sep:
                continue
            previous_services = by_placement[previous["id"]]
            previous_last = previous_services[-1] if previous_services else None
            previous_counter = previous_last["game_counter"] if previous_last else previous["initial_game_counter"]
            delta = current["initial_game_counter"] - previous_counter
            if delta:
                suspect_placements.add(current["id"])
            transitions.append({
                "machine": machine,
                "old_placement_id": previous["id"],
                "new_placement_id": current["id"],
                "started_at": current["started_at"],
                "same_address": previous["address"] == current["address"],
                "same_location": previous["location_id"] == current["location_id"],
                "initial_counter_delta": delta,
                "previous_last_service_id": previous_last["id"] if previous_last else None,
                "previous_last_service_at": previous_last["occurred_at"] if previous_last else None,
                "new_first_service_id": by_placement[current["id"]][0]["id"] if by_placement[current["id"]] else None,
            })

    periods, mismatches = [], []
    for placement_id, services in by_placement.items():
        placement = placements[placement_id]
        previous_game = placement["initial_game_counter"]
        previous_time = timestamp(placement["started_at"])
        for i, row in enumerate(services):
            end = timestamp(row["occurred_at"])
            divisor = number(row["counter_divisor_applied"] or 1)
            divisor = divisor if divisor > 0 else Decimal(1)
            games = (number(row["game_counter"] - previous_game) / divisor - number(row["test_games"])).quantize(Decimal(".0001"), rounding=ROUND_HALF_UP)
            revenue = (games * number(row["price_per_game_snapshot"])).quantize(Decimal(".01"), rounding=ROUND_HALF_UP)
            if games != number(row["new_games"]) or revenue != number(row["revenue"]):
                mismatches.append({"id": row["id"], "expected_games": str(games), "expected_revenue": str(revenue)})
            periods.append({
                "id": row["id"], "machine": row["machine_number"], "placement_id": placement_id,
                "start": previous_time, "end": end, "days": days_between(previous_time, end),
                "revenue": float(revenue), "games": float(games),
                "price": float(row["price_per_game_snapshot"]),
                "suspect_first_interval": i == 0 and placement_id in suspect_placements,
            })
            previous_game, previous_time = row["game_counter"], end

    windows = {
        "sep": (sep, oct1), "oct": (oct1, nov1), "nov": (nov1, cutoff),
        "sep15": (sep + dt.timedelta(days=14), oct1),
        "previous28": (cutoff - dt.timedelta(days=56), cutoff - dt.timedelta(days=28)),
        "last28": (cutoff - dt.timedelta(days=28), cutoff),
        "previous14": (cutoff - dt.timedelta(days=28), cutoff - dt.timedelta(days=14)),
        "last14": (cutoff - dt.timedelta(days=14), cutoff),
    }
    by_machine = collections.defaultdict(list)
    for row in periods:
        by_machine[row["machine"]].append(row)
    machine_rows, tests = [], []
    for machine in dataset["machines"]:
        name = machine["machine_number"]
        rows = by_machine[name]
        entry = {"machine": name, "status": machine["status"], "windows": {}}
        for label, (start, end) in windows.items():
            entry["windows"][label] = period_metrics(rows, start, end)
            entry["windows"][label + "_strict"] = period_metrics(rows, start, end, strict=True)
            entry["windows"][label + "_exclude_suspect"] = period_metrics(rows, start, end, exclude_suspect=True)
        recent = [r for r in rows if r["end"] >= sep]
        entry["prices"] = sorted({r["price"] for r in recent})
        entry["active_address"] = next((p["address"] for p in by_machine_placements[name] if p["ended_at"] is None), None)
        entry["last_service"] = max((r["end"] for r in rows), default=None)
        entry["last_service_gap_days"] = days_between(entry["last_service"], timestamp(dataset["snapshot_reference"])) if entry["last_service"] else None
        if not name.upper().startswith("QA-") and entry["active_address"] and len({p["address"] for p in by_machine_placements[name] if p["ended_at"] is None or timestamp(p["ended_at"]) >= sep}) == 1:
            # Month-separated non-overlapping, entirely observed service periods.
            earlier = [r for r in rows if r["start"] >= sep + dt.timedelta(days=7) and r["end"] <= oct1 and 1 <= r["days"] <= 28 and not r["suspect_first_interval"]]
            later = [r for r in rows if r["start"] >= windows["last28"][0] and r["end"] <= cutoff and 1 <= r["days"] <= 28 and not r["suspect_first_interval"]]
            if min(len(earlier), len(later)) >= 3:
                pvalue, exact = rank_permutation_pvalue([r["revenue"] / r["days"] for r in earlier], [r["revenue"] / r["days"] for r in later])
                tests.append({"machine": name, "p": pvalue, "exact_permutation": exact, "earlier_n": len(earlier), "later_n": len(later), "earlier_ids": [r["id"] for r in earlier], "later_ids": [r["id"] for r in later]})
        machine_rows.append(entry)
    bh_adjust(tests)

    note_pattern = re.compile(r"не работа|завис|слом|мало игр|сня|не да|выключ|возврат|закры|пуст|электр|термин|ошиб|клешн|нет связи|вскры", re.I)
    evidence_notes = [{k: r[k] for k in ("id", "machine_number", "service_date", "notes")} for r in dataset["services"] if r["service_date"] >= sep.date().isoformat() and note_pattern.search(r["notes"])]
    output = {
        "dataset_sha256": hashlib.sha256(raw).hexdigest(), "snapshot_reference": dataset["snapshot_reference"], "analysis_end_exclusive": cutoff.isoformat(),
        "formula_mismatches": mismatches, "transitions": transitions,
        "suspect_placement_ids": sorted(suspect_placements), "machines": machine_rows,
        "exploratory_permutation_tests": tests, "notes_evidence": evidence_notes,
        "test_caveat": "Independent closed service periods, not interpolated days. Exchangeability is an assumption; temporal correlation and observational confounding remain. BH covers all eligible machines, not only selected decliners. No causal inference.",
    }
    (args.output / "independent_audit.json").write_text(json.dumps(output, ensure_ascii=False, indent=2, default=str))
    csv_rows = []
    for row in machine_rows:
        for label, metrics in row["windows"].items():
            csv_rows.append({"machine": row["machine"], "window": label, **{k: v for k, v in metrics.items() if k not in ("period_ids", "crossing_ids")}})
    with (args.output / "independent_machine_windows.csv").open("w", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(csv_rows[0]))
        writer.writeheader()
        writer.writerows(csv_rows)
    print(json.dumps({"formula_mismatches": len(mismatches), "suspect_placement_ids": sorted(suspect_placements), "eligible_tests": len(tests), "p_below_005": sum(t["p"] < .05 for t in tests), "q_below_005": sum(t["q_bh"] < .05 for t in tests)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
