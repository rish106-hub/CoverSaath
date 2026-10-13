# Builds the standalone HTML pack: html/index.html (one board) + html/pages/*.html + html/assets/*.png
import json, os, re, shutil, html as H
jobs = json.load(open('jobs.json'))
names = {'d5cb06c8c8e1fc0a0e15b59c7d9848d3':'lightspeed.png','93aa25bc57d9a125e59a24f174efa2c5':'insurance-samadhan.png','059f472400fa02700367e16735c0a120':'irdai.png','91d2cb88644951b75a2a8fcbadb2400e':'localcircles.png','9a2b8696a1d51206c59a50d670254089':'lok-sabha.png','edbf1335c75fd8e4d5f7d7f0630ae2d5':'ministry-of-finance.png','f9a6c8a2c18175956a0442f5c421f7aa':'ministry-of-health.png'}
shutil.rmtree('html', ignore_errors=True); os.makedirs('html/pages'); os.makedirs('html/assets')
for k, n in names.items(): shutil.copy(f'blobs/{k}.png', f'html/assets/{n}')
byid = {j['id']: j for j in jobs}
for j in jobs:
    s = open(f'out/{j["id"]}/static.html', encoding='utf-8').read()
    s = re.sub(r'blobs/([0-9a-f]{32})\.png', lambda m: '../assets/' + names[m.group(1)], s)
    s = re.sub(r'<title>[^<]*</title>', f'<title>Knowvia: {H.escape(j["title"])}</title>', s, count=1)
    s = s.replace('<head>', '<head>\n<meta name="viewport" content="width=device-width, initial-scale=1">', 1)
    open(f'html/pages/{j["id"]}.html', 'w', encoding='utf-8').write(s)
    d = json.load(open(f'out/{j["id"]}/tree.json')); j['h'] = d['h']; j['root'] = d['root']
groups = [('Landing page', ['main', 'mobile']),
          ('Landing page states', [j['id'] for j in jobs if j['id'].startswith(('hero-', 'close-', 'voice-', 'privacy-', 'mobile-menu'))]),
          ('Onboarding (future state)', ['o1-start','o2-event','o3-people','o4-sharing','o5-upload','o6-reading','o7-matrix-mobile','o7-matrix-desktop','extra-states']),
          ('Design system', ['foundations','components','motion'])]
cards = []
for label, ids in groups:
    items = []
    for i in ids:
        j = byid[i]; w = j['w']; sel = j.get('selector'); top = j['root']['y'] if sel else 0; h = j['h']
        k = 0.62 if w <= 500 else (0.24 if w > 2000 else 0.33)
        vis = h if sel else min(h, 4200)
        cap = f'{w} px' + (f' · section {H.escape(sel)}' if sel else '')
        items.append(f'<figure class="board" style="width:{w*k:.0f}px"><figcaption><a href="pages/{i}.html">{H.escape(j["title"])}</a><span>{cap}</span></figcaption>'
                     f'<div class="frame" style="width:{w*k:.0f}px;height:{vis*k:.0f}px"><iframe loading="lazy" src="pages/{i}.html" title="{H.escape(j["title"])}" style="width:{w}px;height:{top+h:.0f}px;transform:scale({k});margin-top:{-top*k:.0f}px" scrolling="no"></iframe></div></figure>')
    cards.append(f'<section><h2>{H.escape(label)}</h2><div class="row">{"".join(items)}</div></section>')
css = """:root{--ink:#1A3034;--tide:#163F42;--slate:#55696D;--mist:#F3F7F6;--rule:#CFDCDA;--harbour:#176F69}
body{margin:0;background:var(--mist);color:var(--ink);font-family:'Source Sans 3',system-ui,sans-serif}
header{padding:48px 40px 8px;max-width:1100px}
h1{font-family:Newsreader,Georgia,serif;font-weight:400;font-size:56px;margin:0 0 12px;color:var(--tide)}
header p{font-size:18px;line-height:1.55;margin:0 0 8px;color:var(--slate)}
section{padding:24px 40px 40px}
h2{font-family:Newsreader,Georgia,serif;font-weight:400;font-size:34px;color:var(--tide);margin:24px 0 20px}
.row{display:flex;flex-wrap:wrap;gap:32px;align-items:flex-start}
.board{margin:0}
figcaption{display:flex;flex-direction:column;gap:2px;margin-bottom:10px;font-size:15px}
figcaption a{color:var(--harbour);font-weight:600}
figcaption span{color:var(--slate);font-size:13px}
.frame{overflow:hidden;border-radius:10px;border:1px solid var(--rule);background:#fff;box-shadow:0 10px 30px rgba(22,62,54,.08)}
iframe{border:0;display:block;transform-origin:0 0;pointer-events:none}"""
index = ('<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Knowvia: all designs</title>\n'
 '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400&family=Source+Sans+3:wght@400;600&display=swap">\n'
 f'<style>\n{css}\n</style></head><body>\n<header><h1>Knowvia: all designs</h1>\n'
 '<p>Every artboard and state from the Claude Design canvas, as standalone HTML. Click a title to open the full page at its real size.</p>\n'
 '<p>Each page in <code>pages/</code> is the design itself: exact fonts, colours, sizes, spacing and animations. The scripts that drove the canvas are removed, so each form, voice note or viewer state has its own page.</p></header>\n'
 + ''.join(cards) + '\n</body></html>')
open('html/index.html', 'w', encoding='utf-8').write(index)
print(len(os.listdir('html/pages')), 'pages')
