#!/usr/bin/env python3
"""Reproducible read-only revenue research on a whitelisted JSON export.

Usage: python revenue-decline.py dataset.json output_directory
No network, database writes, credentials, media access, or embedded business data.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

TZ = ZoneInfo('Europe/Moscow')
DAY = 86400


def dt(value):
    return datetime.fromisoformat(value).astimezone(TZ)


def overlap(a, b, c, d):
    return max(0.0, (min(b, d) - max(a, c)).total_seconds() / DAY)


def ratio(a, b):
    return a / b - 1 if a is not None and b and b > 0 else None


def allocated(intervals, start, end, exclude_anomaly=False):
    selected = [(i, overlap(i['start'], i['end'], start, end)) for i in intervals
                if not (exclude_anomaly and i['is_financial_anomaly'])]
    selected = [(i, w) for i, w in selected if w > 0]
    coverage = sum(w for _, w in selected)
    values = {k: sum(i[k] / i['days'] * w for i, w in selected)
              for k in ('revenue', 'new_games', 'new_prizes', 'cashless_amount', 'cash_amount', 'toy_cost', 'toy_quantity')}
    return dict(coverage=coverage, fraction=coverage / ((end - start).total_seconds() / DAY),
                count=len(selected), rate=values['revenue'] / coverage if coverage else None,
                games_rate=values['new_games'] / coverage if coverage else None,
                **values)


def bootstrap_change(intervals, start0, boundary, end, seed, repetitions=2000):
    selected = [i for i in intervals if overlap(i['start'], i['end'], start0, end) > 0]
    n = len(selected)
    if n < 8:
        return None
    rate = np.array([i['revenue'] / i['days'] for i in selected])
    w0 = np.array([overlap(i['start'], i['end'], start0, boundary) for i in selected])
    w1 = np.array([overlap(i['start'], i['end'], boundary, end) for i in selected])
    rng = np.random.default_rng(seed)
    # Circular moving blocks of two adjacent service intervals preserve short serial dependence.
    starts = rng.integers(0, n, size=(repetitions, (n + 1) // 2))
    indices = np.stack([starts, (starts + 1) % n], axis=-1).reshape(repetitions, -1)[:, :n]
    denominator0 = w0[indices].sum(axis=1)
    denominator1 = w1[indices].sum(axis=1)
    valid = (denominator0 > 0) & (denominator1 > 0)
    rates0 = (rate[indices] * w0[indices]).sum(axis=1)[valid] / denominator0[valid]
    rates1 = (rate[indices] * w1[indices]).sum(axis=1)[valid] / denominator1[valid]
    changes = rates1[rates0 > 0] / rates0[rates0 > 0] - 1
    if len(changes) < repetitions * .9:
        return None
    return {'low': float(np.quantile(changes, .025)),
            'high': float(np.quantile(changes, .975)), 'valid': len(changes), 'block_intervals': 2}


def clean(value):
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    raise TypeError(type(value).__name__)


def run(dataset_path: Path, out: Path, overrides_path: Path | None = None):
    data = json.loads(dataset_path.read_text())
    overrides = json.loads(overrides_path.read_text()) if overrides_path else {}
    excluded_machines = set(overrides.get('excluded_machines', []))
    out.mkdir(parents=True, exist_ok=True)
    snapshot = dt(data['snapshot_reference'])
    end = snapshot.replace(hour=0, minute=0, second=0, microsecond=0)
    sep = datetime(end.year, 9, 1, tzinfo=TZ)
    oct1 = datetime(end.year, 10, 1, tzinfo=TZ)
    nov1 = datetime(end.year, 11, 1, tzinfo=TZ)
    windows = {'sep': (sep, oct1), 'late_sep':(sep+timedelta(days=14),oct1),
               'post_reorg_baseline28':(sep+timedelta(days=14),sep+timedelta(days=42)),
               'oct': (oct1, nov1), 'nov': (nov1, end),
               'prior28': (end-timedelta(days=56), end-timedelta(days=28)),
               'recent28': (end-timedelta(days=28), end),
               'recent_first14': (end-timedelta(days=28), end-timedelta(days=14)),
               'recent_last14': (end-timedelta(days=14), end),
               'prior14': (end-timedelta(days=28), end-timedelta(days=14)),
               'last14': (end-timedelta(days=14), end)}
    machines = {m['machine_number']: m for m in data['machines']}
    placements = {p['id']: p for p in data['placements']}
    locations = {l['id']: l for l in data['locations']}
    staff = {s['id']: s['full_name'].strip() for s in data['staff']}
    toy_counts = defaultdict(int)
    for row in data['toy_distributions']:
        toy_counts[row['service_id']] += row['quantity']
    services_by_placement = defaultdict(list)
    for s in data['services']:
        services_by_placement[s['placement_id']].append(s)
    intervals = []
    for pid, services in services_by_placement.items():
        placement = placements[pid]
        previous = None
        for service in sorted(services, key=lambda s: (dt(s['occurred_at']), s['id'])):
            interval = dict(service)
            prior_placement_services = [s for s in data['services'] if s['machine_number'] == service['machine_number'] and s['placement_id'] != pid and dt(s['occurred_at']) <= dt(placement['started_at'])]
            prior_placement_service = max(prior_placement_services, key=lambda s:dt(s['occurred_at']),default=None) if not previous else None
            discontinuity = bool(not previous and prior_placement_service and prior_placement_service['game_counter'] != placement['initial_game_counter'])
            interval.update(start=dt(previous['occurred_at']) if previous else dt(placement['started_at']),
                            end=dt(service['occurred_at']), prev_service_id=previous['id'] if previous else None,
                            location_id=placement['location_id'], toy_quantity=toy_counts[service['id']],
                            previous_technician_id=previous['technician_id'] if previous else placement['installed_by'],
                            initial_counter_discontinuity=discontinuity)
            interval['days'] = (interval['end'] - interval['start']).total_seconds()/DAY
            if interval['days'] > 0:
                intervals.append(interval)
            previous = service
    by_machine = defaultdict(list)
    for i in intervals:
        by_machine[i['machine_number']].append(i)
    cashless_by_machine = defaultdict(list)
    for row in data['cashless_daily']:
        if row['machine_number'] is not None:
            cashless_by_machine[row['machine_number']].append(row)
    results = []
    for number, m in machines.items():
        ins = sorted(by_machine[number], key=lambda i: i['start'])
        stats = {name: allocated(ins, a, b) for name, (a, b) in windows.items()}
        consistent_ins = [i for i in ins if not i['initial_counter_discontinuity']]
        sep_consistent = allocated(consistent_ins,sep,oct1)
        periods = [p for p in data['placements'] if p['machine_number'] == number]
        relevant_periods = [p for p in periods if dt(p['started_at']) < end and (not p['ended_at'] or dt(p['ended_at']) > sep)]
        active = next((p for p in periods if dt(p['started_at']) < end and (not p['ended_at'] or dt(p['ended_at']) > end)), None)
        latest = max((i['end'] for i in ins if i['end'] <= snapshot), default=None)
        gap = (snapshot-latest).total_seconds()/DAY if latest else None
        observed_placements = {i['placement_id'] for i in ins if overlap(i['start'], i['end'], sep, end) > 0}
        observed_locations = {placements[p]['location_id'] for p in observed_placements}
        current_location = locations.get(active['location_id']) if active else None
        recent_services = [i for i in ins if sep <= i['end'] <= snapshot]
        closing_tech_counts = Counter(staff.get(i['technician_id'], 'Не указан') for i in recent_services)
        rate_change = ratio(stats['recent28']['rate'], stats['prior28']['rate'])
        nov_sep = ratio(stats['nov']['rate'], stats['sep']['rate'])
        oct_sep = ratio(stats['oct']['rate'], stats['sep']['rate'])
        nov_oct = ratio(stats['nov']['rate'], stats['oct']['rate'])
        first14 = ratio(stats['recent_first14']['rate'], stats['prior28']['rate'])
        second14 = ratio(stats['recent_last14']['rate'], stats['prior28']['rate'])
        recent_no_anomaly = allocated(ins, *windows['recent28'], exclude_anomaly=True)
        prior_no_anomaly = allocated(ins, *windows['prior28'], exclude_anomaly=True)
        clean_change = ratio(recent_no_anomaly['rate'], prior_no_anomaly['rate'])
        min_cov = min(stats[k]['fraction'] for k in ('sep','oct','nov','prior28','recent28'))
        window_support = stats['prior28']['coverage'] >= 21 and stats['recent28']['coverage'] >= 21 and stats['prior28']['count'] >= 3 and stats['recent28']['count'] >= 3
        monthly_support = stats['sep']['coverage'] >= 24 and stats['oct']['coverage'] >= 25 and stats['nov']['coverage'] >= 16
        halves_support = stats['recent_first14']['coverage'] >= 9 and stats['recent_last14']['coverage'] >= 9
        eligible = bool(number not in excluded_machines and active and m['status'] == 'ACTIVE' and window_support and monthly_support and halves_support and gap is not None and gap <= 7)
        strict_same_placement = len(observed_placements) == 1
        stable_location = len(observed_locations) == 1
        price_values = {i['price_per_game_snapshot'] for i in ins if overlap(i['start'], i['end'], sep, end)>0}
        divisor_values = {i['counter_divisor_applied'] for i in ins if overlap(i['start'], i['end'], sep, end)>0}
        seed = int(hashlib.sha256(number.encode()).hexdigest()[:8],16)
        ci = bootstrap_change(ins, windows['prior28'][0], windows['prior28'][1], end, seed)
        stable_decline = bool(eligible and stable_location and rate_change is not None and rate_change <= -.20 and nov_sep is not None and nov_sep <= -.20 and first14 is not None and first14 <= -.15 and second14 is not None and second14 <= -.15)
        clean_survives = bool(clean_change is not None and clean_change <= -.10 and recent_no_anomaly['coverage'] >= 14 and prior_no_anomaly['coverage'] >= 14)
        confirmed = bool(stable_decline and clean_survives and ci and ci['high'] < 0)
        status = 'watch' if eligible and rate_change is not None and rate_change <= -.15 else ('rebound' if eligible and oct_sep is not None and oct_sep <= -.15 and nov_oct is not None and nov_oct >= .10 else ('eligible' if eligible else 'insufficient'))
        cashless_stats = {}
        for name,(a,b) in windows.items():
            rows=[r for r in cashless_by_machine[number] if a.date().isoformat() <= r['day'] < b.date().isoformat()]
            cashless_stats[name]={'amount':sum(r['amount'] for r in rows),'transactions':sum(r['transactions'] for r in rows),'rate':sum(r['amount'] for r in rows)/((b-a).total_seconds()/DAY)}
        recent_persistent = bool(eligible and stable_location and rate_change is not None and rate_change <= -.15 and first14 is not None and first14 <= -.15 and second14 is not None and second14 <= -.15 and ci and ci['high'] < 0 and clean_survives)
        late_sep_change = ratio(stats['nov']['rate'], stats['late_sep']['rate'])
        consistent_sep_change = ratio(stats['nov']['rate'], sep_consistent['rate'])
        structural_signal = bool(confirmed and late_sep_change is not None and late_sep_change <= -.20 and consistent_sep_change is not None and consistent_sep_change <= -.20)
        if structural_signal:
            status = 'structural_signal'
        elif recent_persistent:
            status = 'recent_signal'
        row = {'machine_number':number,'machine_type':m['machine_type'],'machine_status':m['status'],'excluded':number in excluded_machines,'location':current_location['name'] if current_location else (locations[relevant_periods[-1]['location_id']]['name'] if relevant_periods else ''),'address':(active or {}).get('address') or (current_location or {}).get('address',''),'active_placement_id':active['id'] if active else None,'placement_ids':sorted(observed_placements),'stable_placement':strict_same_placement,'stable_location':stable_location,'eligible':eligible,'status':status,'recent_persistent':recent_persistent,'latest_observation':latest.isoformat() if latest else None,'gap_days':gap,'visits_since_sep':len(recent_services),'technicians':dict(closing_tech_counts.most_common()),'stats':stats,'change28':rate_change,'nov_vs_sep':nov_sep,'oct_vs_sep':oct_sep,'nov_vs_oct':nov_oct,'nov_vs_late_sep':ratio(stats['nov']['rate'],stats['late_sep']['rate']),'nov_vs_sep_ex_initial':ratio(stats['nov']['rate'],sep_consistent['rate']),'sep_ex_initial':sep_consistent,'initial_discontinuity_intervals':sum(i['initial_counter_discontinuity'] for i in ins if overlap(i['start'],i['end'],sep,end)>0),'first14_vs_prior28':first14,'second14_vs_prior28':second14,'games_change28':ratio(stats['recent28']['games_rate'],stats['prior28']['games_rate']),'price_changes':len(price_values)>1,'prices':sorted(price_values),'divisors':sorted(divisor_values),'confidence95':ci,'no_anomaly_change28':clean_change,'clean_survives':clean_survives,'anomaly_visits':sum(i['is_financial_anomaly'] for i in recent_services),'cashless_actual':cashless_stats,'cashless_actual_change28':ratio(cashless_stats['recent28']['rate'],cashless_stats['prior28']['rate']),'gap30_scenario':max(0,30*((stats['prior28']['rate'] or 0)-(stats['recent28']['rate'] or 0))) if window_support else None,'notes':[{'date':i['service_date'],'service_id':i['id'],'text':i['notes']} for i in recent_services if i['notes']]}
        results.append(row)
    results.sort(key=lambda r:(r['gap30_scenario'] or 0),reverse=True)
    cohort=[r for r in results if r['eligible']]
    stable=[r for r in cohort if r['stable_location']]
    strict=[r for r in cohort if r['stable_placement']]
    network={}
    for name,group in [('eligible',cohort),('stable_location',stable),('stable_placement',strict)]:
        periods={w:{'sum_machine_rates':sum(r['stats'][w]['rate'] or 0 for r in group),'sum_machine_games_rates':sum(r['stats'][w]['games_rate'] or 0 for r in group),'observed_revenue':sum(r['stats'][w]['revenue'] for r in group),'coverage':sum(r['stats'][w]['coverage'] for r in group)} for w in windows}
        common_end = min(dt(r['latest_observation']) for r in group).replace(hour=0,minute=0,second=0,microsecond=0) if group else end
        common_stats = {w:[allocated(by_machine[r['machine_number']],a,b) for r in group] for w,(a,b) in {'prior28':(common_end-timedelta(days=56),common_end-timedelta(days=28)),'recent28':(common_end-timedelta(days=28),common_end)}.items()}
        common_coverage = {w:sum(s['coverage'] for s in ss) for w,ss in common_stats.items()}
        common_rates = {w:sum(s['revenue'] for s in ss)/28 for w,ss in common_stats.items()}
        for w in windows:
            periods[w]['pooled_rate']=periods[w]['observed_revenue']/periods[w]['coverage'] if periods[w]['coverage'] else None
            periods[w]['coverage_quantiles']=np.quantile([r['stats'][w]['coverage'] for r in group],[0,.25,.5,.75,1]).tolist() if group else []
        common_changes=[ratio(b['rate'],a['rate']) for a,b in zip(common_stats['prior28'],common_stats['recent28'])]
        common_changes=[v for v in common_changes if v is not None]
        network[name]={'machines':len(group),'periods':periods,'change28':ratio(periods['recent28']['sum_machine_rates'],periods['prior28']['sum_machine_rates']),'pooled_change28':ratio(periods['recent28']['pooled_rate'],periods['prior28']['pooled_rate']),'nov_vs_sep':ratio(periods['nov']['sum_machine_rates'],periods['sep']['sum_machine_rates']),'median_change28':float(np.median([r['change28'] for r in group])) if group else None,'down20':sum((r['change28'] or 0)<=-.2 for r in group),'common_cutoff':{'end_exclusive':common_end.isoformat(),'prior28_rate':common_rates['prior28'],'recent28_rate':common_rates['recent28'],'prior28_average_machine_rate':common_rates['prior28']/len(group) if group else None,'recent28_average_machine_rate':common_rates['recent28']/len(group) if group else None,'change':ratio(common_rates['recent28'],common_rates['prior28']),'median_machine_change':float(np.median(common_changes)) if common_changes else None,'coverage':common_coverage,'expected_coverage_each':len(group)*28}}
    factor=1+(network['stable_location']['change28'] or 0)
    for r in results:
        r['relative_network_change28']=(1+r['change28'])/factor-1 if r['change28'] is not None and factor>0 else None
    weekly=[]
    starts=[]
    day=sep
    while day<end:
        starts.append(day);day+=timedelta(days=7)
    for number, ins in by_machine.items():
        for a in starts:
            b=min(a+timedelta(days=7),end)
            vals=allocated(ins,a,b)
            if vals['coverage']:
                weekly.append(dict(machine_number=number,start=a.date().isoformat(),end=b.date().isoformat(),**vals))
    status_counts=dict(Counter(r['status'] for r in results))
    meta={'dataset_sha256':hashlib.sha256(dataset_path.read_bytes()).hexdigest(),'snapshot_reference':snapshot.isoformat(),'extracted_at':data['extracted_at'],'analysis_start':sep.isoformat(),'analysis_end_exclusive':end.isoformat(),'windows':{k:[a.isoformat(),b.isoformat()] for k,(a,b) in windows.items()},'overrides':overrides,'counts':{k:len(v) for k,v in data.items() if isinstance(v,list)},'intervals':len(intervals),'services_since_sep':sum(sep<=dt(s['occurred_at'])<=snapshot for s in data['services']),'status_counts':status_counts,'network':network,'criteria':{'coverage_days':{'sep':24,'oct':25,'nov':16,'prior28':21,'recent28':21,'halves14':9},'minimum_intervals_each28':3,'max_latest_gap_days':7,'persistent_drop28':-.20,'persistent_drop_nov_sep':-.20,'each_recent_half_vs_prior28':-.15,'bootstrap_repetitions':2000,'bootstrap_block_intervals':2,'confidence':'Descriptive 95% moving service-block bootstrap interval; no multiple-testing adjustment; not causal or predictive.'}}
    (out/'trend_results.json').write_text(json.dumps({'meta':meta,'machines':results,'weekly':weekly},ensure_ascii=False,indent=2,default=clean))
    (out/'trend_meta.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2,default=clean))
    columns=['machine_number','machine_type','location','status','eligible','stable_placement','stable_location','gap_days','visits_since_sep','technicians','sep_rate','oct_rate','nov_rate','prior28_rate','recent28_rate','change28','nov_vs_sep','nov_vs_late_sep','nov_vs_sep_ex_initial','oct_vs_sep','nov_vs_oct','games_change28','cashless_actual_change28','relative_network_change28','gap30_scenario','ci_low','ci_high','price_changes','prices','anomaly_visits','no_anomaly_change28','sep_coverage','oct_coverage','nov_coverage','prior28_coverage','recent28_coverage','prior28_intervals','recent28_intervals']
    with (out/'machine_ranking.csv').open('w',encoding='utf-8-sig',newline='') as stream:
        writer=csv.DictWriter(stream,fieldnames=columns);writer.writeheader()
        for r in results:
            row={k:r.get(k) for k in columns}
            row['technicians']='; '.join(f'{k}: {v}' for k,v in r['technicians'].items())
            row['prices']=';'.join(str(v) for v in r['prices'])
            for w in ('sep','oct','nov','prior28','recent28'):
                row[w+'_rate']=r['stats'][w]['rate'];row[w+'_coverage']=r['stats'][w]['coverage']
            for w in ('prior28','recent28'):row[w+'_intervals']=r['stats'][w]['count']
            row['ci_low']=(r['confidence95'] or {}).get('low');row['ci_high']=(r['confidence95'] or {}).get('high')
            writer.writerow(row)
    interval_columns=['id','machine_number','placement_id','start','end','days','prev_service_id','technician_id','previous_technician_id','revenue','new_games','new_prizes','price_per_game_snapshot','counter_divisor_applied','cashless_amount','cash_amount','is_financial_anomaly','toy_cost','toy_quantity']
    with (out/'intervals.csv').open('w',encoding='utf-8-sig',newline='') as stream:
        writer=csv.DictWriter(stream,fieldnames=interval_columns,extrasaction='ignore');writer.writeheader()
        writer.writerows({k:(clean(v) if isinstance(v,datetime) else v) for k,v in i.items()} for i in intervals)
    chart={'meta':{'snapshot':snapshot.isoformat(),'analysis_end':end.date().isoformat(),'network':network,'status_counts':status_counts},'machines':[{k:r[k] for k in ('machine_number','machine_type','location','status','technicians','change28','relative_network_change28','nov_vs_sep','nov_vs_late_sep','nov_vs_sep_ex_initial','gap30_scenario','confidence95','latest_observation','gap_days','price_changes','anomaly_visits')} | {'monthly':{w:{k:r['stats'][w][k] for k in ('rate','coverage','count','revenue','games_rate')} for w in ('sep','oct','nov')},'prior28':r['stats']['prior28'],'recent28':r['stats']['recent28']} for r in results],'weekly':weekly}
    (out/'chart_data.json').write_text(json.dumps(chart,ensure_ascii=False,default=clean,separators=(',',':')))
    def compact_period(s):
        return [round(s['rate'],2) if s['rate'] is not None else None,
                round(s['games_rate'],3) if s['games_rate'] is not None else None,
                round(s['coverage'],3),s['count'],round(s['revenue'],2),
                round(s['toy_quantity']/s['coverage'],3) if s['coverage'] else None,
                round(100*s['toy_cost']/s['revenue'],2) if s['revenue'] else None]
    signals={r['machine_number'] for r in results if r['status'] in ('structural_signal','recent_signal')}
    compact={'period_fields':['rub_per_observed_day','games_per_observed_day','covered_days','service_intervals','allocated_revenue','replenished_toy_proxy_per_observed_day','replenishment_cost_proxy_percent'],
             'notes':'Revenue/games allocated uniformly within completed counter intervals; no extrapolation after last service. Toy fields are replenishment-flow proxies assigned to the closing interval, not observed stock or true consumed prizes. Service intervals may overlap adjacent windows.',
             'windows':meta['windows'],'snapshot':snapshot.isoformat(),'network':{'machines':network['stable_location']['machines'],'common_cutoff':network['stable_location']['common_cutoff'],'recent_rolling_change':network['stable_location']['change28'],'recent_rolling_pooled_change':network['stable_location']['pooled_change28'],'recent_rolling_median_change':network['stable_location']['median_change28'],'monthly_sum_machine_rates':{w:network['stable_location']['periods'][w]['sum_machine_rates'] for w in ('sep','oct','nov')}},
             'machines':[{'id':r['machine_number'],'location':r['location'],'type':r['machine_type'],'class':r['status'],'eligible':r['eligible'],'same_location':r['stable_location'],'p':{w:compact_period(r['stats'][w]) for w in ('sep','oct','nov','prior28','recent28')},'change28':r['change28'],'late_sep_change':r['nov_vs_late_sep'],'sep_ex_initial_change':r['nov_vs_sep_ex_initial'],'card_change28':r['cashless_actual_change28'],'gap30':r['gap30_scenario'],'last_observation':r['latest_observation'],'gap_days':r['gap_days']} for r in results],
             'weekly_fields':['machine_number','week_start','rub_per_observed_day','games_per_observed_day','covered_days','service_intervals'],
             'weekly':[[r['machine_number'],r['start'],round(r['rate'],2) if r['rate'] is not None else None,round(r['games_rate'],3) if r['games_rate'] is not None else None,round(r['coverage'],3),r['count']] for r in weekly if r['machine_number'] in signals]}
    (out/'compact_chart_data.json').write_text(json.dumps(compact,ensure_ascii=False,default=clean,separators=(',',':')))
    cases=[]
    for r in results:
        ins=by_machine[r['machine_number']]
        actual=cashless_by_machine[r['machine_number']]
        cases.append(dict(r, intervals=[{k:(clean(v) if isinstance(v,datetime) else v) for k,v in i.items() if k not in ('photo_object_key','local_id')} for i in ins if overlap(i['start'],i['end'],sep,end)>0],
                          cashless_latest_day=max((v['day'] for v in actual),default=None),
                          cashless_last10_days=sorted(actual,key=lambda v:v['day'])[-10:]))
    (out/'machine_case_data.json').write_text(json.dumps(cases,ensure_ascii=False,indent=2,default=clean))
    closure_summary=[]
    for supplied in overrides.get('closed_placements', []):
        pid=supplied['placement_id']
        closure_at=dt(supplied['closure_at'])
        selected=[i for i in intervals if i['placement_id']==pid]
        closure_summary.append(dict(supplied,sep=allocated(selected,sep,oct1),oct=allocated(selected,oct1,nov1),
                                    last28_before_closure=allocated(selected,closure_at-timedelta(days=28),closure_at),
                                    observed_gap_to_new_placement_days=min(((dt(p['started_at'])-closure_at).total_seconds()/DAY for p in data['placements'] if p['id'] in supplied.get('new_placement_ids',[])),default=None)))
    (out/'closure_summary.json').write_text(json.dumps(closure_summary,ensure_ascii=False,indent=2,default=clean))
    print(json.dumps({'status_counts':status_counts,'network':network,'signals':[{k:r[k] for k in ('machine_number','location','status','change28','nov_vs_sep','nov_vs_late_sep','nov_vs_sep_ex_initial','relative_network_change28','gap30_scenario','confidence95','no_anomaly_change28','price_changes','anomaly_visits')} for r in results if r['status'] in ('structural_signal','recent_signal')],'watch_top':[{k:r[k] for k in ('machine_number','location','change28','nov_vs_sep','gap30_scenario')} for r in results if r['status']=='watch'][:15]},ensure_ascii=False,indent=2,default=clean))


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('dataset',type=Path);parser.add_argument('output_directory',type=Path)
    parser.add_argument('--overrides',type=Path,help='Local JSON containing excluded_machines and owner-confirmed closures; never commit business records.')
    args=parser.parse_args();run(args.dataset,args.output_directory,args.overrides)
