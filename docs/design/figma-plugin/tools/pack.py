# usage: pack.py hashes.json page_name out.png job1 job2 ...
import sys, json
sys.path.insert(0, '.')
from packpng import pack
hp, page, outp, cols, jobs = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5:]
H = json.load(open(hp))
missing = []
def fix(n, job):
    if n.get('t') == 'I':
        src = n.pop('src', '')
        if src.startswith('blobs/'):
            k = 'blob:' + src[6:-4]
            if k in H: n['hash'] = H[k]
            else: missing.append(k)
    for f in n.get('f') or []:
        if f.get('k') == 'IMG':
            k = f'{job}/{f["key"]}.png'
            if k in H: f['hash'] = H[k]
            else: missing.append(k)
    for c in n.get('k') or []: fix(c, job)
P = {'page': page, 'gap': 160, 'vars': True, 'cols': cols, 'jobs': []}
for j in jobs:
    d = json.load(open(f'out/{j}/tree.json'))
    fix(d['tree'], j)
    P['jobs'].append({'id': j, 'title': d['title'], 'tree': d['tree']})
P['builder'] = open('builder.js').read()
data = json.dumps(P, separators=(',', ':'), ensure_ascii=False).encode()
h = pack(data, outp)
print('bytes', len(data), 'rows', h, 'missing', missing)
