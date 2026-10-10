import json, subprocess, time
def get(url):
    try: return json.loads(subprocess.run(['curl','-s','-b','simap/jar','-H','Accept: application/json',url],capture_output=True,text=True,timeout=30).stdout)
    except Exception: return {}
rows=json.load(open('simap/awards244.json')); out={}
for r in rows:
    a=get(f"https://www.simap.ch/api/publications/v1/project/{r['id']}/publication-details/{r['publicationId']}")
    ref=(a.get('referencingPub') or {}).get('publicationId')
    t=get(f"https://www.simap.ch/api/publications/v1/project/{r['id']}/publication-details/{ref}") if ref else {}
    out[r['id']]={'award':a,'tender':t}
    time.sleep(0.2)
json.dump(out,open('simap/full244.json','w'),ensure_ascii=False)
print('done',len(out),'with tender',sum(bool(v['tender']) for v in out.values()))
