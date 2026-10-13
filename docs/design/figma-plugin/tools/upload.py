# usage: upload.py hashes.json urls.txt file1 file2 ...   (keys derived from paths)
import sys, json, subprocess, os
hp, up, files = sys.argv[1], sys.argv[2], sys.argv[3:]
urls = [u.strip() for u in open(up) if u.strip()]
assert len(urls) >= len(files), (len(urls), len(files))
H = json.load(open(hp)) if os.path.exists(hp) else {}
placed = H.setdefault('_placed', [])
for f, u in zip(files, urls):
    key = os.path.relpath(f, 'out') if f.startswith('out/') else 'blob:' + os.path.basename(f)[:-4] if f.startswith('blobs/') else 'data:' + os.path.basename(f)
    r = subprocess.run(['curl', '-sS', '-X', 'POST', '-F', f'file=@{f};type=image/png', u], capture_output=True, text=True)
    j = json.loads(r.stdout)
    H[key] = j['imageHash']; placed.append(j.get('placedOnNodeId'))
    print(key, j['imageHash'][:10], j.get('placedOnNodeId'))
json.dump(H, open(hp, 'w'), indent=1)
