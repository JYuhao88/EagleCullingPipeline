#!/usr/bin/env python3
"""Render checked, local contact-sheet HTML into JPEG overview pages (36 cards/page).

Usage: python3 ml/references/render_genre_qa.py /tmp/w3-genres-data/wulin/qa/*.html
Requires Pillow. Images are written beside their HTML inputs; never pass repo paths.
"""
import base64,html,io,re,sys,math
from pathlib import Path
from PIL import Image,ImageDraw
for name in sys.argv[1:]:
 p=Path(name);cards=re.findall(r'<article>(.*?)</article>',p.read_text(),re.S)
 for page in range(math.ceil(len(cards)/36)):
  items=cards[page*36:(page+1)*36];sheet=Image.new('RGB',(1440,math.ceil(len(items)/6)*168),'white');draw=ImageDraw.Draw(sheet)
  for i,card in enumerate(items):
   imdata=re.search(r'data:image/jpeg;base64,([^"]+)',card)
   if imdata:
    im=Image.open(io.BytesIO(base64.b64decode(imdata[1])));im.thumbnail((240,135));sheet.paste(im,(i%6*240,i//6*168))
   label=html.unescape(re.search(r'<b>(.*?)</b>',card)[1]).replace('–','-').replace('·','|');draw.text((i%6*240+3,i//6*168+137),label,fill='black')
  target=p.with_name(p.stem+f'-sheet-{page}.jpg');sheet.save(target,quality=92);print(target,len(items))
