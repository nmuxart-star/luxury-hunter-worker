# Recorta la foto del bolso y lee la referencia y los likes de cada captura de
# ficha de Vestiaire (OCR de Vision ya hecho, en JSONL). Uso:
# python3 -I scripts/tools/vestiaire-crop-photos.py ocr.jsonl carpeta_salida
import json, re, sys, os
from PIL import Image
src, outdir = sys.argv[1], sys.argv[2]
os.makedirs(outdir, exist_ok=True)
result = {}
for line in open(src):
    j = json.loads(line); W, H = j['w'], j['h']; its = j['items']
    ref = None
    for it in its:
        m = re.search(r'Referencia[:\s]*(\d{6,})', it['t'])
        if m: ref = m.group(1); break
    if not ref:
        for it in its:
            if 'Referencia' in it['t']:
                c = [x for x in its if abs(x['y'] - it['y']) < 8 and re.fullmatch(r'\d{6,}', x['t'].strip())]
                if c: ref = c[0]['t'].strip(); break
    if not ref: continue
    desc = next((x for x in its if x['t'].strip().startswith('Descrip') and x['x'] < W * 0.3), None)
    bottom = desc['y'] - 15 if desc else H * 0.45
    price = [x for x in its if '€' in x['t'] and x['x'] > W * 0.45 and x['y'] < bottom]
    right = (min(x['x'] for x in price) - 20) if price else W * 0.5
    title = next((x for x in its if x['t'].strip() == 'Balenciaga' and x['y'] < bottom), None)
    likes, top = None, (title['y'] + 90 if title else H * 0.12)
    for x in its:
        m = re.fullmatch(r'\s*(\d{1,4})\s*[0OoQ♡DVv]?\s*', x['t'])
        if m and W * 0.25 < x['x'] < right and (title is None or x['y'] > title['y']) and x['y'] < bottom * 0.6:
            likes = int(m.group(1)); top = x['y'] + x['h'] + 6; break
    img = Image.open(j['file']).convert('RGB')
    box = (int(W * 0.11), int(top), int(right), int(bottom))
    crop = img.crop(box)
    g = crop.convert('L').point(lambda p: 255 if p < 232 else 0)
    bb = g.getbbox()
    if bb:
        pad = 6
        crop = crop.crop((max(0, bb[0] - pad), max(0, bb[1] - pad), min(crop.width, bb[2] + pad), min(crop.height, bb[3] + pad)))
    crop.thumbnail((360, 360))
    out = os.path.join(outdir, f'{ref}.jpg')
    if ref not in result:
        crop.save(out, 'JPEG', quality=85)
        result[ref] = {'likes': likes, 'file': out, 'screen': os.path.basename(j['file'])}
json.dump(result, open(os.path.join(outdir, 'index.json'), 'w'), indent=1)
print(len(result), 'fotos;', sum(1 for v in result.values() if v['likes'] is not None), 'con likes')
