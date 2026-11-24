#!/usr/bin/env python3
"""Read an explicitly supplied curated JSON export; write local research results.

No database connection, credentials, or production mutation is supported. Individual
output rows contain business data and must not be committed. Dependencies: numpy,
pandas, scipy. Toy replenishment closes the preceding interval (DECISION-091);
setup technician/toys are paired with the NEXT service in the SAME placement.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats


def timestamps(values):
    return pd.to_datetime(values, utc=True, format="ISO8601")


def clean_json(value):
    if isinstance(value, dict):
        return {str(k): clean_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [clean_json(v) for v in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating, float)):
        return float(value) if np.isfinite(value) else None
    if isinstance(value, (pd.Timestamp,)):
        return value.isoformat()
    return value


def fixed_effects(frame, columns):
    parts = [pd.Series(1.0, index=frame.index, name="constant")]
    parts += [pd.get_dummies(frame[c].astype(str), prefix=c, drop_first=True, dtype=float) for c in columns]
    return pd.concat(parts, axis=1)


def ols_cluster(frame, outcome, features, effects=("placement_id", "next_month")):
    """OLS with machine-cluster CR1 sandwich covariance and t(G-1) intervals."""
    cols = [outcome, *features, *effects, "machine_number"]
    f = frame.dropna(subset=list(dict.fromkeys(cols))).copy()
    x = pd.concat([fixed_effects(f, effects), f[features].astype(float)], axis=1)
    # Retain full-rank columns in order; FE-unidentified treatments are omitted.
    matrix = x.to_numpy(dtype=float)
    from scipy.linalg import qr
    _, r, pivots = qr(matrix, mode="economic", pivoting=True)
    tolerance = np.finfo(float).eps * max(matrix.shape) * abs(r[0, 0])
    rank = int((abs(np.diag(r)) > tolerance).sum())
    selected = sorted(pivots[:rank])
    x = x.iloc[:, selected]
    matrix = x.to_numpy(dtype=float)
    y = f[outcome].to_numpy(dtype=float)
    beta = np.linalg.lstsq(matrix, y, rcond=None)[0]
    residual = y - matrix @ beta
    bread = np.linalg.pinv(matrix.T @ matrix)
    groups = f.machine_number.astype(str).to_numpy()
    unique = np.unique(groups)
    scores = np.array([(matrix[groups == g] * residual[groups == g, None]).sum(axis=0) for g in unique])
    n, k = matrix.shape
    g = len(unique)
    covariance = bread @ (scores.T @ scores) @ bread
    if g > 1 and n > k:
        covariance *= g / (g - 1) * (n - 1) / (n - k)
    se = np.sqrt(np.maximum(np.diag(covariance), 0))
    critical = stats.t.ppf(.975, max(g - 1, 1))
    coefficients = {}
    for name in features:
        if name not in x.columns:
            coefficients[name] = {"identified": False}
            continue
        i = x.columns.get_loc(name)
        coefficients[name] = {"identified": True, "beta": beta[i], "se_cluster": se[i],
                              "ci_low": beta[i] - critical * se[i], "ci_high": beta[i] + critical * se[i],
                              "p_cluster_t": 2 * stats.t.sf(abs(beta[i] / se[i]), max(g - 1, 1)) if se[i] else None}
    return {"n": n, "machines": g, "rank": k, "r_squared": 1 - (residual @ residual) / ((y - y.mean()) @ (y - y.mean())),
            "outcome": outcome, "effects": list(effects), "coefficients": coefficients}


def residual_correlation(frame, left, right, controls, effects=("placement_id", "next_month")):
    f = frame.dropna(subset=[left, right, *controls]).copy()
    matrix = pd.concat([fixed_effects(f, effects), f[controls]], axis=1).to_numpy(dtype=float)
    residuals = []
    for c in (left, right):
        v = f[c].to_numpy(dtype=float)
        residuals.append(v - matrix @ np.linalg.lstsq(matrix, v, rcond=None)[0])
    return {"n": len(f), "r": np.corrcoef(*residuals)[0, 1]}


def weighted_rate(f, numerator="next_revenue", denominator="next_days"):
    return float(f[numerator].sum() / f[denominator].sum()) if f[denominator].sum() else None


def weekend_share(left, right):
    left = left.tz_convert("Europe/Moscow")
    right = right.tz_convert("Europe/Moscow")
    total = (right - left).total_seconds()
    weekend = 0.0
    for day in pd.date_range(left.normalize(), right.normalize(), freq="D"):
        if day.dayofweek >= 5:
            weekend += max(0, (min(right, day + pd.Timedelta(days=1)) - max(left, day)).total_seconds())
    return weekend / total if total > 0 else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("dataset", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--start", default="2026-09-01")
    parser.add_argument("--closed-location", action="append", type=int, default=[],
                        help="Owner-confirmed closed location ID; excludes its periods from association models.")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    data = json.loads(args.dataset.read_text())
    start = pd.Timestamp(args.start, tz="Europe/Moscow").tz_convert("UTC")
    cutoff = pd.Timestamp(data["snapshot_reference"])
    # Descriptive monthly rates use complete Moscow calendar days, matching
    # revenue-decline.py. Completed service pairs can still use today's snapshot.
    monthly_cutoff = cutoff.tz_convert("Europe/Moscow").normalize()
    staff = {r["id"]: r for r in data["staff"]}
    machines = pd.DataFrame(data["machines"]).set_index("machine_number")
    places = pd.DataFrame(data["placements"]).set_index("id")
    toy_rows = pd.DataFrame(data["toy_distributions"])
    qty = toy_rows.groupby("service_id").quantity.sum()
    s = pd.DataFrame(data["services"])
    s["event_at"] = timestamps(s.occurred_at)
    s = s.sort_values(["placement_id", "event_at", "id"]).reset_index(drop=True)
    s["first_in_placement"] = s.groupby("placement_id").cumcount().eq(0)
    s["location_id"] = s.placement_id.map(places.location_id)
    s["owner_closed_location"] = s.location_id.isin(args.closed_location)
    s["period_start"] = s.groupby("placement_id").event_at.shift().fillna(timestamps(s.placement_id.map(places.started_at)))
    s["days"] = (s.event_at - s.period_start).dt.total_seconds() / 86400
    for c in ["revenue", "toy_cost", "new_games", "cashless_amount", "price_per_game_snapshot", "new_prizes", "test_games"]:
        s[c] = pd.to_numeric(s[c])
    s["toy_quantity"] = s.id.map(qty).fillna(0)
    s["toy_unit_cost"] = s.toy_cost / s.toy_quantity.replace(0, np.nan)
    s["payout"] = s.toy_cost / s.revenue.replace(0, np.nan)
    s["margin"] = s.revenue - s.toy_cost
    s["revenue_day"] = s.revenue / s.days.replace(0, np.nan)
    s["games_day"] = s.new_games / s.days.replace(0, np.nan)
    s["margin_day"] = s.margin / s.days.replace(0, np.nan)
    s["toy_day"] = s.toy_quantity / s.days.replace(0, np.nan)
    s["tech"] = s.technician_id.map(lambda x: staff.get(x, {}).get("full_name", "Не указан").strip())
    s["field_tech"] = s.technician_id.map(lambda x: staff.get(x, {}).get("is_field_technician", False))
    s["author"] = s.created_by.map(lambda x: staff.get(x, {}).get("full_name", "Не указан").strip())
    s["machine_type"] = s.machine_number.map(machines.machine_type)
    s["month"] = s.event_at.dt.tz_convert("Europe/Moscow").dt.strftime("%Y-%m")
    for c in ["event_at", "days", "revenue", "new_games", "toy_cost", "payout", "margin", "revenue_day", "games_day", "margin_day", "price_per_game_snapshot", "tech", "id"]:
        s["next_" + c] = s.groupby("placement_id")[c].shift(-1)
    s["next_month"] = s.next_event_at.dt.tz_convert("Europe/Moscow").dt.strftime("%Y-%m")
    s["previous_tech"] = s.groupby("placement_id").tech.shift()
    s["switched_tech"] = s.tech.ne(s.previous_tech) & s.previous_tech.notna()
    visits = s[(s.event_at >= start) & (s.event_at <= cutoff)].copy()
    pairs_all = visits[(visits.kind == "REGULAR") & visits.next_days.between(1, 28) & visits.days.between(1, 28)
                   & visits.next_event_at.le(cutoff)].copy()
    # First periods can inherit installation/import counter baselines. Exclude
    # all such periods, rather than deciding from their observed outcomes.
    pairs = pairs_all[~pairs_all.owner_closed_location & ~pairs_all.first_in_placement].copy()
    for col in ["toy_quantity", "revenue_day", "games_day", "days", "next_days", "next_revenue_day", "next_games_day"]:
        pairs["log_" + col] = np.log1p(pairs[col])
    pairs["price_ratio"] = np.log(pairs.next_price_per_game_snapshot / pairs.price_per_game_snapshot)
    pairs["payout10"] = pairs.payout * 10
    pairs["payout10"] = pairs.payout10.clip(0, 20)  # sensitivity model additionally excludes extreme payout
    pairs["next_rate_ratio"] = pairs.next_games_day / pairs.games_day.replace(0, np.nan)
    pairs["next_weekend_share"] = [weekend_share(a, b) for a, b in zip(pairs.event_at, pairs.next_event_at)]
    pairs["next_week"] = pairs.next_event_at.dt.tz_convert("Europe/Moscow").dt.strftime("%G-W%V")
    pairs.to_csv(args.output / "maintenance_pairs.csv", index=False)
    visits.to_csv(args.output / "maintenance_visits.csv", index=False)

    summary = {"snapshot_reference": data["snapshot_reference"], "monthly_analysis_end_exclusive": monthly_cutoff.isoformat(), "visits": len(visits), "regular_visits": int((visits.kind == "REGULAR").sum()),
               "unknown_technician": int(visits.technician_id.isna().sum()), "pairs": len(pairs), "pair_machines": pairs.machine_number.nunique(),
               "visits_by_author": visits.author.value_counts().to_dict(), "excluded_days_lt1": int((visits.days < 1).sum()),
               "excluded_days_gt28": int((visits.days > 28).sum()), "claw_settings_total": len(data["claw_settings"])}
    summary["association_exclusions"] = {"closed_location_ids": args.closed_location,
        "closed_location_pairs": int(pairs_all.owner_closed_location.sum()),
        "first_placement_pairs": int(pairs_all.first_in_placement.sum()),
        "pairs_before_exclusions": len(pairs_all)}
    tech_rows = []
    for tech, v in visits.groupby("tech"):
        p = pairs[pairs.tech == tech]
        active_machines = v.machine_number.nunique()
        tech_rows.append({"technician": tech, "visits": len(v), "share_percent": 100 * len(v) / len(visits),
                          "machines": active_machines, "median_closing_interval_days": v.days.median(),
                          "mean_closing_interval_days": v.days.mean(), "toy_quantity": v.toy_quantity.sum(),
                          "zero_toys_visits": int(v.toy_quantity.eq(0).sum()),
                          "zero_toys_percent": 100 * v.toy_quantity.eq(0).mean(),
                          "median_toy_quantity": v.toy_quantity.median(), "cost": v.toy_cost.sum(),
                          "next_pairs": len(p), "next_machines": p.machine_number.nunique(),
                          "next_revenue_day_unadjusted": weighted_rate(p),
                          "next_margin_day_unadjusted": weighted_rate(p, "next_margin"),
                          "next_payout_percent": 100 * p.next_toy_cost.sum() / p.next_revenue.sum() if p.next_revenue.sum() else None})
    pd.DataFrame(tech_rows).sort_values("visits", ascending=False).to_csv(args.output / "technicians.csv", index=False)
    machine_tech = visits.groupby(["machine_number", "tech"]).agg(visits=("id", "size"), median_days=("days", "median"),
                       toy_quantity=("toy_quantity", "sum"), cost=("toy_cost", "sum")).reset_index()
    machine_tech["share"] = machine_tech.visits / machine_tech.groupby("machine_number").visits.transform("sum")
    machine_tech.to_csv(args.output / "machine_technicians.csv", index=False)

    correlations = {}
    for label, f in [("all", pairs), *[(str(t), g) for t, g in pairs.groupby("machine_type")]]:
        if len(f) < 20:
            continue
        correlations[label] = {"n": len(f), "quantity_current_games_total_spearman": stats.spearmanr(f.toy_quantity, f.new_games).statistic,
                "quantity_current_games_day_spearman": stats.spearmanr(f.toy_quantity, f.games_day).statistic,
                "quantity_next_games_day_spearman": stats.spearmanr(f.toy_quantity, f.next_games_day).statistic,
                "quantity_next_rate_within_machine_month": residual_correlation(f, "log_toy_quantity", "log_next_games_day", ["log_days", "log_next_days"]),
                "quantity_next_rate_controlling_current": residual_correlation(f, "log_toy_quantity", "log_next_games_day", ["log_games_day", "log_days", "log_next_days"])}
    summary["correlations"] = correlations
    controls = ["log_games_day", "log_days", "log_next_days", "price_ratio", "next_weekend_share"]
    models = {}
    for label, f in [("all", pairs), ("minikh", pairs[pairs.machine_type == "МиникХ"]),
                     ("one_to_21days", pairs[pairs.days.le(21) & pairs.next_days.le(21)]),
                     ("since_sep15", pairs[pairs.event_at.ge(pd.Timestamp("2026-09-15", tz="Europe/Moscow"))]),
                     ("since_oct1", pairs[pairs.event_at.ge(pd.Timestamp("2026-10-01", tz="Europe/Moscow"))]),
                     ("positive_games", pairs[pairs.games_day.gt(0) & pairs.next_games_day.gt(0)])]:
        models[label + "_toys"] = ols_cluster(f, "log_next_games_day", ["log_toy_quantity", *controls])
        models[label + "_payout"] = ols_cluster(f[f.payout.between(0, 1)], "log_next_games_day", ["payout10", *controls])
    models["all_toys_week"] = ols_cluster(pairs, "log_next_games_day", ["log_toy_quantity", *controls], effects=("placement_id", "next_week"))
    # Tech coefficients are identified ONLY by machines visited by several technicians.
    field_pairs = pairs[pairs.field_tech].copy()
    overlap_places = field_pairs.groupby("placement_id").tech.nunique()
    overlap_places = overlap_places[overlap_places >= 2].index
    overlap = field_pairs[field_pairs.placement_id.isin(overlap_places)].copy()
    names = set(overlap.tech.unique())
    adjacency = {name: {name} for name in names}
    for _, q in overlap.groupby("placement_id"):
        for name in q.tech.unique():
            adjacency[name].update(q.tech.unique())
    components = []
    while names:
        reached = {next(iter(sorted(names)))}
        while True:
            expanded = set().union(*(adjacency[name] for name in reached))
            if expanded == reached:
                break
            reached = expanded
        components.append(sorted(reached))
        names -= reached
    summary["technician_components"] = []
    for index, component in enumerate(components, 1):
        f = overlap[overlap.tech.isin(component)].copy()
        reference = f.tech.value_counts().index[0]
        features = []
        for name in sorted(component):
            if name != reference:
                feature = "tech_" + name
                f[feature] = (f.tech == name).astype(float)
                features.append(feature)
        model = ols_cluster(f, "log_next_games_day", [*features, "log_toy_quantity", *controls])
        models["technician_component_" + str(index)] = model
        models["technician_component_" + str(index) + "_week"] = ols_cluster(f, "log_next_games_day", [*features, "log_toy_quantity", *controls], effects=("placement_id", "next_week"))
        models["technician_component_" + str(index) + "_no_toy_control"] = ols_cluster(f, "log_next_games_day", [*features, *controls])
        summary["technician_components"].append({"component": component, "reference": reference, "pairs": len(f),
             "machines": f.machine_number.nunique(), "placements": f.placement_id.nunique(),
             "support": f.groupby("tech").agg(pairs=("id", "size"), machines=("machine_number", "nunique")).reset_index().to_dict("records")})
    summary["technician_overlap_machines"] = overlap.machine_number.nunique()
    summary["technician_overlap_pairs"] = len(overlap)
    summary["models"] = models
    summary["switches"] = pairs.groupby("switched_tech").agg(n=("id", "size"), median_next_vs_prior_games=("next_rate_ratio", "median")).reset_index().to_dict("records")

    payout_bins = pd.cut(pairs.payout, [-np.inf, .1, .2, .3, .4, .5, np.inf], labels=["<10%", "10–20%", "20–30%", "30–40%", "40–50%", "50%+"])
    bucket_rows = []
    for label, f in pairs.groupby(payout_bins, observed=True):
        bucket_rows.append({"payout_bucket": str(label), "n": len(f), "machines": f.machine_number.nunique(),
                            "next_games_day": weighted_rate(f, "next_new_games"), "next_revenue_day": weighted_rate(f),
                            "next_margin_day": weighted_rate(f, "next_margin"), "median_next_vs_current_games": f.next_rate_ratio.median()})
    pd.DataFrame(bucket_rows).to_csv(args.output / "payout_buckets.csv", index=False)

    # Calendar allocation is an accounting estimate, not daily observed sales.
    monthly_rows = []
    for month in pd.date_range(start.tz_convert("Europe/Moscow").normalize(), monthly_cutoff, freq="MS"):
        end = min(month + pd.offsets.MonthBegin(1), monthly_cutoff)
        f = s[s.days.gt(0)].copy()
        overlap_days = ((f.event_at.clip(upper=end.tz_convert("UTC")) -
                         f.period_start.clip(lower=month.tz_convert("UTC"))).dt.total_seconds() / 86400).clip(lower=0)
        f["overlap_days"] = overlap_days
        f = f[f.overlap_days > 0]
        for machine, q in f.groupby("machine_number"):
            weight = q.overlap_days / q.days
            rev = (q.revenue * weight).sum(); cost = (q.toy_cost * weight).sum()
            monthly_rows.append({"machine_number": machine, "month": month.strftime("%Y-%m"), "covered_days": q.overlap_days.sum(),
                                 "revenue": rev, "toy_cost": cost, "margin": rev - cost, "payout": cost / rev if rev else None,
                                 "toy_quantity": (q.toy_quantity * weight).sum(), "toy_cost_unit": cost / (q.toy_quantity * weight).sum() if (q.toy_quantity * weight).sum() else None,
                                 "revenue_day": rev / q.overlap_days.sum(), "margin_day": (rev - cost) / q.overlap_days.sum()})
    pd.DataFrame(monthly_rows).to_csv(args.output / "maintenance_monthly.csv", index=False)
    monthly_clean = []
    for month in pd.date_range(start.tz_convert("Europe/Moscow").normalize(), monthly_cutoff, freq="MS"):
        end = min(month + pd.offsets.MonthBegin(1), monthly_cutoff)
        f = s[s.days.gt(0) & ~s.first_in_placement & ~s.owner_closed_location].copy()
        f["overlap_days"] = ((f.event_at.clip(upper=end.tz_convert("UTC")) -
                               f.period_start.clip(lower=month.tz_convert("UTC"))).dt.total_seconds() / 86400).clip(lower=0)
        for machine, q in f[f.overlap_days.gt(0)].groupby("machine_number"):
            w = q.overlap_days / q.days
            rev = (q.revenue * w).sum(); cost = (q.toy_cost * w).sum(); quantity = (q.toy_quantity * w).sum(); days = q.overlap_days.sum()
            monthly_clean.append({"machine_number": machine, "month": month.strftime("%Y-%m"), "covered_days": days,
                                  "revenue": rev, "toy_cost": cost, "payout": cost / rev if rev else None,
                                  "revenue_day": rev / days, "margin_day": (rev - cost) / days, "toys_day": quantity / days})
    pd.DataFrame(monthly_clean).to_csv(args.output / "maintenance_monthly_clean.csv", index=False)
    notes = visits[visits.notes.str.contains("пуст|слома|застр|не работ|нераб|мало игруш|не выда|не бер|перезап|термин|оплат|интернет|свет|перемещ|закры", case=False, na=False)].copy()
    notes[["id", "machine_number", "event_at", "tech", "notes"]].to_csv(args.output / "maintenance_note_signals.csv", index=False)
    summary["note_signals"] = len(notes)
    claw = pd.DataFrame(data["claw_settings"])
    claw["event_at"] = timestamps(claw.effective_at)
    claw = claw.sort_values(["machine_number", "event_at", "id"])
    claw["previous_weak"] = claw.groupby("machine_number").weak.shift()
    claw["previous_prize_set"] = claw.groupby("machine_number").prize_set.shift()
    claw["previous_at"] = claw.groupby("machine_number").event_at.shift()
    claw["next_at"] = claw.groupby("machine_number").event_at.shift(-1)
    claw["days_since_change"] = (cutoff - claw.event_at).dt.total_seconds() / 86400
    claw.to_csv(args.output / "claw_history.csv", index=False)
    summary["claw_since_start"] = int((claw.event_at >= start).sum())
    summary["claw_machines"] = claw.machine_number.nunique()
    summary["claw_known_weak_changes"] = int((claw.weak.ne(claw.previous_weak) & claw.previous_weak.notna()).sum())
    summary["claw_known_weak_changes_full14d"] = int((claw.weak.ne(claw.previous_weak) & claw.previous_weak.notna() & claw.days_since_change.ge(14)).sum())
    summary["claw_first_date"] = claw.event_at.min()
    summary["claw_full_14d_changes"] = int((claw.days_since_change >= 14).sum())
    summary["zero_toys_visits"] = int(visits.toy_quantity.eq(0).sum())
    summary["zero_toys_positive_revenue"] = int((visits.toy_quantity.eq(0) & visits.revenue.gt(0)).sum())
    summary["toy_snapshot_price_counts"] = toy_rows.groupby(["toy_id", "unit_cost_snapshot"]).size().reset_index(name="lines").to_dict("records")
    toy_history = toy_rows.merge(s[["id", "event_at"]], left_on="service_id", right_on="id")
    toy_history = toy_history[toy_history.event_at.ge(start)]
    toy_history.groupby(["toy_id", "unit_cost_snapshot"]).agg(lines=("quantity", "size"), quantity=("quantity", "sum"),
                    first=("event_at", "min"), last=("event_at", "max")).reset_index().to_csv(args.output / "toy_price_history_since_start.csv", index=False)
    summary["totals_by_closing_date"] = {"revenue": visits.revenue.sum(), "toy_cost": visits.toy_cost.sum(), "margin": visits.margin.sum(), "payout": visits.toy_cost.sum() / visits.revenue.sum()}
    (args.output / "maintenance_summary.json").write_text(json.dumps(clean_json(summary), ensure_ascii=False, indent=2, allow_nan=False))
    print(json.dumps(clean_json({k: summary[k] for k in ["visits", "pairs", "pair_machines", "technician_overlap_machines", "claw_machines"]}), ensure_ascii=False))


if __name__ == "__main__":
    main()
