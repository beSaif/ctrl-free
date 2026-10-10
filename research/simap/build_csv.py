import json, csv, re, html, sys
full = json.load(open('simap/full244.json'))
search = {r['id']: r for r in json.load(open('simap/awards244.json'))}
def tx(t):
    if not isinstance(t, dict): return ''
    s = t.get('de') or t.get('fr') or t.get('it') or t.get('en') or ''
    s = re.sub(r'<br\s*/?>|</p>|</li>', '\n', s); s = re.sub(r'<[^>]+>', '', s)
    return re.sub(r'[ \t]+', ' ', re.sub(r'\n\s*\n+', '\n', html.unescape(s))).strip()
def price_weight(t, just):
    for c in ((t.get('criteria') or {}).get('awardCriteria') or []):
        if c.get('isPriceCriterion') and c.get('weighting') is not None: return c['weighting'], 'tender criteria'
    for src, txt in (('tender criteria note', tx((t.get('criteria') or {}).get('awardCriteriaNote'))), ('award justification', just)):
        m = re.search(r'(?:Preis|prix|prezzo)[^%\n]{0,60}?(\d{1,3})\s*%', txt, re.I)
        if m: return int(m.group(1)), src
    return '', ''
out = []
for pid, v in full.items():
    a, t, s = v['award'], v['tender'] or {}, search[pid]
    dec = a.get('decision') or {}; vs = dec.get('vendors') or []
    prices = [(x.get('price') or {}).get('price') for x in vs]
    rng = ((dec.get('totalPriceRange') or {}).get('range') or {})
    sel = dec.get('totalPriceSelection')
    status = {'price_of_selected_offers': 'price', 'price_range_of_selected_offers': 'range',
              'no_specification_according_to_ppa_law': 'not published'}.get(sel, sel or 'unknown')
    if status == 'price' and not any(prices): status = 'not published'
    vat = next(((x.get('price') or {}).get('vatType') for x in vs if x.get('price')), '') or (dec.get('totalPriceRange') or {}).get('vatType') or ''
    just = tx(dec.get('awardDecisionJustification'))
    pw, pw_src = price_weight(t, just)
    oa = (a.get('procurement') or {}).get('orderAddress') or s.get('orderAddress') or {}
    out.append({
        'simap_link': f'https://www.simap.ch/de/project-detail/{pid}',
        'project_number': s.get('projectNumber'), 'award_publication_number': s.get('publicationNumber'),
        'award_published': s.get('publicationDate'), 'award_decided': dec.get('awardDecisionDate') or '',
        'tender_published': ((t.get('base') or {}).get('publicationDate') or ''),
        'offer_deadline': (((t.get('dates') or {}).get('offerDeadline') or '')[:10]),
        'title': tx(s.get('title')), 'client': tx(s.get('procOfficeName')),
        'canton': oa.get('cantonId') or ((a.get('project-info') or {}).get('procOfficeAddress') or {}).get('cantonId') or '',
        'city': tx(oa.get('city')) if isinstance(oa.get('city'), dict) else (oa.get('city') or ''), 'procedure': s.get('processType'),
        'bids_received': dec.get('numberOfSubmissions') if dec.get('numberOfSubmissions') is not None else '',
        'winner': '; '.join(x.get('vendorName', '') for x in vs),
        'winner_city': '; '.join(((x.get('vendorAddress') or {}).get('city') or '') for x in vs),
        'price_status': status,
        'awarded_price_chf': round(sum(p for p in prices if p), 2) if any(prices) else '',
        'price_range_from_chf': rng.get('from') or '', 'price_range_to_chf': rng.get('to') or '',
        'vat': vat, 'price_weight_pct': pw, 'price_weight_source': pw_src,
        'award_justification': just, 'project_description': tx((t.get('procurement') or {}).get('orderDescription')),
    })
out.sort(key=lambda r: r['award_published'], reverse=True)
with open(sys.argv[1], 'w', newline='', encoding='utf-8-sig') as f:
    w = csv.DictWriter(f, fieldnames=list(out[0])); w.writeheader(); w.writerows(out)
import collections as C
print(len(out), C.Counter(r['price_status'] for r in out), 'price weight found', sum(bool(r['price_weight_pct']) for r in out),
      'with description', sum(bool(r['project_description']) for r in out))
