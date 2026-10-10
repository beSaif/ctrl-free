import json, subprocess, time, urllib.parse, collections
def get(url):
    return json.loads(subprocess.run(['curl','-s','-b','simap/jar','-H','Accept: application/json',url],capture_output=True,text=True).stdout)
base='https://www.simap.ch/api/publications/v2/project/project-search?lang=de&newestPubTypes=award_tender&bkpCodes=244'
rows=[]; last=None
for _ in range(60):
    d=get(base+(f'&lastItem={urllib.parse.quote(last)}' if last else ''))
    ps=d.get('projects') or []
    rows+=ps
    last=(d.get('pagination') or {}).get('lastItem')
    if not ps or not last: break
    time.sleep(0.3)
json.dump(rows,open('simap/awards244.json','w'))
print('total', len(rows), 'oldest', rows[-1]['publicationDate'] if rows else None)
print(collections.Counter(r['publicationDate'][:4] for r in rows))
ob=get(base.replace('bkpCodes=244','search=Oberglatt').replace('newestPubTypes=award_tender&',''))
for p in ob.get('projects',[])[:8]: print('OBERGLATT', p['publicationDate'], p['pubType'], (p['title']['de'] or '')[:100])
