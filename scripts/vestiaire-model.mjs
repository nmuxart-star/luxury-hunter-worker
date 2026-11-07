// MISMO MODELO (regla de Nil): la reventa de un anuncio solo se compara con
// anuncios de su base del MISMO modelo. El color, el material y la talla pueden
// cambiar, el modelo no: Mamma Baguette no es Baguette, la Jackie 1961 no es la
// Jackie vintage, un Lady D-Joy no es un Lady Dior y un Black Bay no es un
// Pelagos. Cada fila de la hoja y cada anuncio se reducen a un "modelo" y solo
// valen las filas con el mismo.
export const modelNorm=t=>String(t||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase().replace(/\s+/g,' ').trim();

// Formatos que conviven en cualquier pestaña y nunca son el modelo principal.
const FORMATS=[
  ['cartera',/\bwallet\b|\bwoc\b|cartera|billetero|portefeuille|tarjetero|card ?holder|钱包|財布|ウォレット|지갑/i],
  ['riñonera',/ri[nñ]onera|belt ?bag|bum ?bag|cintur|腰包|ウエストバッグ/i],
  ['tote',/\bcabas\b|\btote\b|shopping|shopper|托特|トート|토트/i],
  ['pochette',/pochette|clutch|vanity|neceser|手拿包|クラッチ|클러치/i]
];

// Pestañas de un solo modelo: nombre del modelo (y cómo se escribe en otros
// idiomas) y sus variantes, que son modelos distintos. Gana la primera que
// coincida; sin variante ni formato, es el modelo principal.
const SINGLE=[
  [/fendi baguette/i,'Baguette',/baguette|法棍|バゲット|바게트/i,[
    ['Mamma Baguette',/mamma|妈妈包|マンマ/i,true],['Baguette Chain',/chain|midi/i],['Flat Baguette',/\bflat\b/i],
    ['Baguette 1997',/1997|re-?edition/i],['Baguette Twist',/twist/i],['Baguette Cage',/\bcage\b/i],
    ['Half Moon Baguette',/half ?moon/i],['Baguette Soft Trunk',/soft ?trunk/i]]],
  [/balenciaga.*city/i,'City',/\bcity\b|机车包|シティ|시티/i,[
    ['Part Time',/part ?time/i,true],['Neo Classic',/neo ?classic/i,true],['Neo Cagole',/cagole/i,true],['City Clip',/\bclip\b/i],
    ['East-West',/east.?west/i],['Boston',/boston/i]]],
  [/lady dior/i,'Lady Dior',/lady ?dior|戴妃|レディ ?ディオール|레이디 ?디올/i,[
    ['Lady D-Joy',/d-?joy/i,true],['Lady D-Lite',/d-?lite/i,true],['Lady D-Sire',/d-?sire/i,true],['Lady 95.22',/95[.,]?22/i,true],
    ['My Lady Dior',/\bmy (lady )?dior\b|\bmy abcdior\b/i,true],['Miss Dior',/miss ?dior/i,true]]],
  [/dior saddle/i,'Saddle',/saddle|马鞍|サドル|새들/i,[
    ['Double Saddle',/double/i],['Saddle Bowler',/bowler/i],['Saddle Soft',/\bsoft\b/i]]],
  [/chanel.*flap/i,'Classic Flap',/classic|timeless|classique|2\.55|\bcf\b|flap|口盖|マトラッセ|matelass|クラシック|클래식|플랩|마트라세/i,[
    ['Reissue 2.55',/2\.55|reissue/i,true],
    ['Trendy CC',/trendy/i,true],['Chanel 19',/chanel ?19\b|^19$/i,true],['Boy',/\bboy\b/i,true],['Chanel 22',/chanel ?22\b/i,true],
    ['Coco Handle',/coco handle|top handle/i,true],['Gabrielle',/gabrielle/i,true],['Deauville',/deauville/i,true]]],
  [/evelyne/i,'Evelyne',/evelyne|エブリン|エヴリン|伊夫林|伊芙琳|에블린/i,[]],
  [/gucci jackie/i,'Jackie',/jackie|ジャッキー|재키|杰奎琳/i,[
    ['Jackie 1961',/1961/i],['Jackie Hobo',/hobo/i],['Jackie Soft',/\bsoft\b/i],['Jackie Bardot',/bardot/i],
    ['Jackie Notte',/notte/i],['Jackie Flap',/\bflap\b/i],['Jackie vintage',/vintage|jackie ?o\b|古着|ヴィンテージ|빈티지/i]]],
  [/loulou puffer/i,'Loulou Puffer',/loulou|ルル|露露|puffer|パファー|云朵包/i,[]],
  [/side trunk/i,'Side Trunk',/side ?trunk|サイドトランク/i,[]],
  [/bottega veneta veneta/i,'Veneta',/veneta|ヴェネタ|베네타/i,[]],
  [/triomphe/i,'Triomphe',/triomphe|凯旋门|トリオンフ|트리옹프/i,[
    ['Teen Triomphe',/\bteen\b/i],['Triomphe Long',/\blong\b/i],['Triomphe Chain',/chain|maillon/i],
    ['Triomphe Halfmoon',/half ?moon/i],['Ava',/\bava\b/i],['Claude',/claude/i],['Besace',/besace/i],
    ['Triomphe Bucket',/bucket|\bseau\b/i],['Boston',/boston/i]]],
  [/rodeo/i,'Rodeo',/rodeo|ロデオ|로데오/i,[]],
  [/luggage/i,'Luggage',/luggage|笑脸|ラゲージ|러기지/i,[['Luggage Phantom',/phantom/i,true]]],
  [/puzzle/i,'Puzzle',/puzzle|パズル|퍼즐|几何包/i,[['Puzzle Fold',/\bfold\b/i],['Puzzle Edge',/\bedge\b/i]]],
  [/teckel/i,'Le Teckel',/teckel|テッケル|腊肠包/i,[]]
];
// Pestañas de varios modelos de bolso fijos: el anuncio tiene que nombrar uno.
const MULTI_FIXED=[
  [/miu miu/i,[['Wander',/wander/i],['Arcadie',/arcadie/i],['Beau',/\bbeau\b/i]]]
];
const BRANDS=[
  ['chanel',/chanel|香奈儿|シャネル|샤넬/i],['dior',/dior|迪奥|ディオール|디올/i],['hermes',/herm[eè]s|爱马仕|エルメス|에르메스/i],
  ['prada',/prada|普拉达|プラダ|프라다/i],['fendi',/fendi|芬迪|フェンディ|펜디/i],['louis vuitton',/louis ?vuitton|\blv\b|路易威登|ヴィトン|루이비통/i],
  ['gucci',/gucci|古驰|グッチ|구찌/i],['saint laurent',/saint ?laurent|\bysl\b|圣罗兰|サンローラン|생로랑/i],
  ['bottega veneta',/bottega|葆蝶家|ボッテガ|보테가/i],['celine',/c[eé]line|赛琳|セリーヌ|셀린/i],['loewe',/loewe|罗意威|ロエベ|로에베/i],
  ['chloe',/chlo[eé]|蔻依|クロエ|끌로에/i],['goyard',/goyard|戈雅|ゴヤール|고야드/i],['miu miu',/miu ?miu|缪缪|ミュウミュウ|미우미우/i],
  ['balenciaga',/balenciaga|巴黎世家|バレンシアガ|발렌시아가/i],['loro piana',/loro ?piana/i],['the row',/the row/i]
];
export const brandOf=t=>(BRANDS.find(([,re])=>re.test(String(t||'')))||[])[0]||null;
// Talla y tipo de Vestiaire que no forman parte del nombre del modelo.
const SIZE_WORDS=/\b(mini bolso|bolso|bandolera|boston|cabas|nano|mini|micro|small|medium|large|grande|pm|mm|gm|tpm|bb|vintage)\b/g;
const modelName=t=>modelNorm(t).replace(/[-_\/]/g,' ').replace(SIZE_WORDS,' ').replace(/^de (cuero|lona)$/,'').replace(/[^a-z0-9 .\-]/g,' ').replace(/\s+/g,' ').trim();
// Para comparar nombres: singular y plural iguales ("Accessoire" = "Accessoires").
const sing=t=>String(t||'').replace(/\b([a-z]{4,})s\b/g,'$1');
const isWatchTab=tab=>/omega|cartier|tudor|seiko|tag heuer|rolex|reloj|watch|speedmaster|seamaster|breitling|iwc|panerai/i.test(tab||'');

function singleKey(spec,text,{vintage=false,requireBase=false,formatText=null}={}){
  const [,base,baseRe,variants]=spec;
  // "(no Edge)", "not the Teen": lo negado no cuenta como variante.
  const t=String(text||'').replace(/\b(?:no|not|non|sin)\s+(?:es\s+|is\s+|the\s+|el\s+|la\s+)?[\w.-]+/gi,' ');
  const named=baseRe.test(t);
  // En el anuncio, una variante con nombre genérico ("vintage", "chain"...)
  // solo cuenta si también nombra el modelo; las de nombre propio (D-Joy,
  // Part Time...) valen solas.
  for(const [key,re,own] of variants)if(re.test(t)&&(own||named||!requireBase))return {key,explicit:true};
  if(requireBase&&!named)return null;
  if(vintage&&variants.some(([k])=>k==='Jackie vintage'))return {key:'Jackie vintage',explicit:true};
  // El formato (tote, cartera...) sale de lo identificado si lo hay: los títulos
  // de Asia van llenos de palabras de relleno ("caben el móvil y la cartera").
  const ft=String(formatText??t).replace(/\b(?:no|not|non|sin)\s+(?:es\s+|is\s+|the\s+|el\s+|la\s+)?[\w.-]+/gi,' ');
  for(const [fmt,re] of FORMATS)if(re.test(ft))return {key:`${base} · ${fmt}`,explicit:named};
  return {key:base,explicit:named};
}

// Modelo de una fila de la hoja de esa pestaña (null si no se sabe).
export function rowModelKey(tab,f){
  if(isWatchTab(tab)){
    const m=modelName(f?.model);
    return m||null;
  }
  const single=SINGLE.find(([re])=>re.test(tab));
  if(single){
    // An explicit Modelo column wins over the name of the tab. Never silently
    // turn a Bobby in a Lady Dior tab into a Lady Dior.
    const explicit=String(f?.model||'').trim();
    if(explicit&&!singleKey(single,explicit,{requireBase:true}))return modelName(explicit)||null;
    return singleKey(single,`${explicit} ${f?.size||''} ${f?.notes||''}`,{vintage:!!f?.vintage}).key;
  }
  const fixed=MULTI_FIXED.find(([re])=>re.test(tab));
  if(fixed){const hit=fixed[1].find(([,re])=>re.test(`${f?.model||''} ${f?.size||''} ${f?.notes||''}`));return hit?hit[0]:null;}
  const m=modelName(f?.model||f?.size);
  if(!m||m.length<3)return null;
  const brand=/radar/i.test(tab)?(brandOf(f?.brand)||brandOf(f?.notes)):null;
  return brand?`${brand} · ${m}`:m;
}

// Filas de la pestaña con el mismo modelo que el anuncio.
// texts: {title, label, description}; label = marca/modelo/variante que dio la
// verificación. explicit = el anuncio nombra el modelo (necesario para buscarlo
// en otras pestañas).
export function sameModelRows(tab,rows,texts={},{requireNamed=false}={}){
  const title=`${texts.title||''} ${texts.label||''}`;
  const all=`${title} ${texts.description||''}`;
  const list=(rows||[]).map(f=>({f,key:rowModelKey(tab,f)})).filter(x=>x.key);
  if(!list.length)return null;
  let key=null,explicit=false;
  if(isWatchTab(tab)){
    // Primero la referencia exacta; si no, el nombre del modelo más largo citado.
    const flat=v=>modelNorm(v).replace(/[.\-\s\/]/g,'');
    for(const t of [title,all]){
      const tf=flat(t);
      const byRef=list.find(x=>{const r=flat(x.f.size);return /\d{3}/.test(r)&&r.length>=5&&tf.includes(r);});
      if(byRef){key=byRef.key;break;}
      const tn=` ${sing(modelName(t))} `;
      // Un "modelo" que es solo la marca (p. ej. "Grand Seiko") no sirve para
      // acotar: se miraría solo un trozo de la pestaña.
      const generic=new Set([...list.map(x=>modelName(x.f.brand)),modelName(tab)].filter(Boolean));
      const byName=[...new Set(list.map(x=>x.key))].filter(k=>k.length>=3&&!generic.has(k)&&tn.includes(` ${sing(k)} `)).sort((a,b)=>b.length-a.length)[0];
      if(byName){key=byName;break;}
    }
    explicit=!!key;
  }else{
    const single=SINGLE.find(([re])=>re.test(tab));
    const vintage=/vintage|古着|ヴィンテージ|빈티지/i.test(title);
    if(single){
      // El anuncio tiene que nombrar el modelo (en cualquier idioma).
      const label=String(texts.label||'').trim();
      const k=singleKey(single,title,{vintage,requireBase:true,formatText:label||String(texts.title||'')});
      if(k){key=k.key;explicit=k.explicit;}
    }else{
      const fixed=MULTI_FIXED.find(([re])=>re.test(tab));
      if(fixed){
        for(const t of [title,all]){const hit=fixed[1].find(([,re])=>re.test(t));if(hit){key=hit[0];break;}}
      }else{
        // Radar, Murakami...: el nombre de modelo (de la hoja) más largo que cite
        // el anuncio y, en Radar, de la misma marca.
        for(const t of [title,all]){
          const tn=` ${sing(modelName(t))} `;
          const brand=brandOf(t)||brandOf(texts.label);
          const hit=[...new Set(list.map(x=>x.key))]
            .map(k=>{const [b,m]=k.includes(' · ')?k.split(' · '):[null,k];return {k,b,m};})
            .filter(({b,m})=>m.length>=3&&tn.includes(` ${sing(m)} `)&&(!b||b===brand))
            .sort((a,b)=>b.m.length-a.m.length)[0];
          if(hit){key=hit.k;break;}
        }
      }
      explicit=!!key;
    }
  }
  if(!key||(requireNamed&&!explicit))return null;
  const same=list.filter(x=>sing(x.key)===sing(key)).map(x=>x.f);
  return same.length?{key,explicit,rows:same}:null;
}

// MISMO TIPO DE MATERIAL (regla de Nil): un bolso de tela o sintético (lona,
// nylon, Cannage de tela...) no se compara con uno de piel, que vale mucho más,
// ni con piel exótica. Lo de imitación y las mezclas tela+piel cuentan como tela.
const MATERIAL_CLASSES=[
  ['tela',/imitaci|faux|sint[eé]tic|synthetic|lona|canvas|toile|\btela\b|fabric|nylon|nailon|poliamid|polyamid|polyest|seda|silk|satin|terciopelo|velvet|denim|vaquero|algod|cotton|\blino\b|linen|\blana\b|wool|tweed|lentejuel|sequin|crochet|raf+ia|jacquard|monogram|帆布|尼龙|ナイロン|キャンバス|ツイード|ベロア|나일론|캔버스/i],
  ['exotica',/cocodril|croc|alligator|caim[aá]n|pit[oó]n|python|avestruz|ostrich|lagart|lizard|ex[oó]tic|serpiente|snake|鳄鱼|蟒|鸵鸟|蜥蜴|クロコ|パイソン|オーストリッチ|リザード|악어|파이톤/i],
  ['piel',/cuero|piel|leather|cuir|pelle|leder|charol|patent|vernis|\bante\b|suede|daim|cordero|lambskin|calfskin|caviar|becerro|ternera|vachetta|羊皮|牛皮|皮革|漆皮|レザー|ラムスキン|カーフ|エナメル|가죽|램스킨/i]
];
export function materialClass(text){
  return (MATERIAL_CLASSES.find(([,re])=>re.test(String(text||'')))||[])[0]||null;
}
// Filas con el mismo tipo de material que el anuncio. Sin material conocido en
// el anuncio no se filtra; las filas sin material no cuentan si sí se conoce.
export function sameMaterialRows(rows,itemMaterialText){
  const cls=materialClass(itemMaterialText);
  if(!cls)return {material:null,rows:rows||[]};
  return {material:cls,rows:(rows||[]).filter(f=>materialClass(String(f?.material||'').trim()||f?.notes)===cls)};
}
