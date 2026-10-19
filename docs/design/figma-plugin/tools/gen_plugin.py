import json, base64, os, re
OUT = 'plugin'
os.makedirs(OUT, exist_ok=True)
rows = [
  ('Landing page', ['main', 'mobile'], 9),
  ('Landing page states', ['hero-empty','hero-invalid','hero-submitting','hero-success','hero-network','hero-server','close-empty','close-invalid','close-submitting','close-success','close-network','close-server','voice-idle','voice-recording','voice-recorded','privacy-family','privacy-you','mobile-menu'], 6),
  ('Onboarding (future state)', ['o1-start','o2-event','o3-people','o4-sharing','o5-upload','o6-reading','o7-matrix-mobile','o7-matrix-desktop','extra-states'], 9),
  ('Design system', ['foundations','components','motion'], 9),
]
images = {}
def b64(path): return base64.b64encode(open(path,'rb').read()).decode()
def fix(n, job):
    if n.get('t') == 'I':
        src = n.pop('src', '')
        m = re.match(r'blobs/([0-9a-f]{32})\.png', src)
        if m:
            k = 'blob:' + m.group(1); n['hash'] = '@' + k
            if k not in images: images[k] = b64(f'blobs/{m.group(1)}.png')
    for f in n.get('f') or []:
        if f.get('k') == 'IMG':
            k = f'{job}/{f["key"]}'; f['hash'] = '@' + k
            if k not in images: images[k] = b64(f'out/{job}/{f["key"]}.png')
    for c in n.get('k') or []: fix(c, job)
R = []
y = 0
for label, jobs, cols in rows:
    js = []
    for j in jobs:
        d = json.load(open(f'out/{j}/tree.json')); fix(d['tree'], j)
        js.append({'id': j, 'title': d['title'], 'tree': d['tree']})
    # height of this row block
    hs = [x['tree']['h'] for x in js]
    blockH = 0
    for i in range(0, len(hs), cols): blockH += max(hs[i:i+cols]) + 240
    R.append({'label': label, 'y': y, 'cols': cols, 'jobs': js})
    y += blockH + 600
builder = open('builder.js').read()
NOTE_TEXT = open('note.txt').read()
tokens = open('tokens-code.js').read().replace("if(old) return {skipped:'exists'};", "if(old) return {skipped:'exists'};")
code = f'''// Knowvia design import. Builds every Knowvia board on the current page, exactly as designed in Claude Design.
// Generated file: do not edit by hand.
const ROWS = {json.dumps(R, separators=(',',':'), ensure_ascii=False)};
const IMAGES = {json.dumps(images, separators=(',',':'))};
const NOTE = {json.dumps(NOTE_TEXT, ensure_ascii=False)};
async function buildTokens(figma) {{
{tokens}
}}
async function buildBoards(figma, P) {{
{builder}
}}
function resolve(n, H) {{
  if (n.hash && n.hash[0] === '@') n.hash = H[n.hash.slice(1)];
  if (n.f) for (const f of n.f) if (f.hash && f.hash[0] === '@') f.hash = H[f.hash.slice(1)];
  if (n.k) for (const c of n.k) resolve(c, H);
}}
(async () => {{
  try {{
    figma.ui.hide && figma.ui.hide();
    const H = {{}};
    for (const k in IMAGES) H[k] = figma.createImage(figma.base64Decode(IMAGES[k])).hash;
    const tok = await buildTokens(figma);
    const page = figma.currentPage;
    page.name = 'Knowvia: all designs';
    await figma.loadFontAsync({{ family: 'Newsreader', style: 'Regular' }});
    await figma.loadFontAsync({{ family: 'Source Sans 3', style: 'Regular' }});
    let layers = 0; const errors = [];
    for (const row of ROWS) {{
      const t = figma.createText();
      t.fontName = {{ family: 'Newsreader', style: 'Regular' }};
      t.characters = row.label; t.fontSize = 160;
      t.fills = [{{ type: 'SOLID', color: {{ r: 0.086, g: 0.247, b: 0.259 }} }}];
      page.appendChild(t); t.x = 0; t.y = row.y - 320; t.name = 'Row title: ' + row.label;
      for (const j of row.jobs) resolve(j.tree, H);
      const res = await buildBoards(figma, {{ page: page.name, jobs: row.jobs, x: 0, y: row.y, cols: row.cols, gap: 160, vars: true }});
      layers += res.count; errors.push(...res.errors);
    }}
    const note = figma.createText();
    note.fontName = {{ family: 'Source Sans 3', style: 'Regular' }};
    note.characters = NOTE; note.fontSize = 40; note.lineHeight = {{ unit: 'PERCENT', value: 140 }};
    note.fills = [{{ type: 'SOLID', color: {{ r: 0.102, g: 0.188, b: 0.204 }} }}];
    page.appendChild(note); note.resize(2600, note.height); note.textAutoResize = 'HEIGHT'; note.x = 0; note.y = -2200; note.name = 'Read me';
    figma.viewport.scrollAndZoomIntoView(page.children);
    figma.closePlugin('Knowvia: ' + layers + ' layers built' + (errors.length ? ', ' + errors.length + ' warnings' : '') + '. Tokens: ' + JSON.stringify(tok));
  }} catch (e) {{
    figma.closePlugin('Knowvia import failed: ' + (e && e.message ? e.message : e));
  }}
}})();
'''
open(f'{OUT}/code.js', 'w').write(code)
json.dump({'name': 'Knowvia design import', 'id': 'knowvia-design-import', 'api': '1.0.0', 'main': 'code.js', 'editorType': ['figma'], 'documentAccess': 'dynamic-page', 'networkAccess': {'allowedDomains': ['none']}}, open(f'{OUT}/manifest.json', 'w'), indent=2)
print('code.js bytes', os.path.getsize(f'{OUT}/code.js'), 'images', len(images), 'rows', [(r['label'], r['y']) for r in R])
