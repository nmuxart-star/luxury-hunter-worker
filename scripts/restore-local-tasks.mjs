const base='http://127.0.0.1:8200';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function api(method,path,body){
  const r=await fetch(base+path,{
    method,
    headers:{'content-type':'application/json'},
    body:body===undefined?undefined:JSON.stringify(body)
  });
  const txt=await r.text();
  let data={};
  try{data=txt?JSON.parse(txt):{}}catch{data={raw:txt}}
  if(!r.ok) throw new Error(`${method} ${path}: ${r.status} ${data.error||txt}`);
  return data;
}

const BALENCIAGA = `TARGET: Balenciaga City / Classic City / Motorcycle City / Le City handbags suitable for resale in Europe.

ACCEPT:
- Balenciaga City, Classic City, Motorcycle City, Le City and authentic vintage City.
- Primary target is STANDARD / MEDIUM size.
- Vintage Classic City and modern Le City are both valid when commercially relevant.

REJECT:
- Le Cagole, Neo Cagole, Hourglass, Rodeo, Crush, Work, Day, Part-Time, Twiggy, First, Mini City, Nano City, XS City.
- Unrelated or generic motorcycle bags.
- HIGH authenticity risk.
- Severe condition issues that destroy resale economics.

SIZE:
- Medium / standard classic width is typically around 35–40 cm.
- Distinguish standard City from Mini, First, Twiggy, Work and other silhouettes.

CONDITION:
- Evaluate leather grain, patina, dryness, restoration, corners, handles, strap, mirror, hardware and interior.
- Distinguish desirable vintage character from deterioration.

AUTHENTICITY:
- Evaluate construction, leather, hardware, logo/branding, serial details where visible, seller consistency and overall plausibility.
- Never certify authenticity from photos alone.
- HIGH authenticity risk = REJECT.

SELLER:
- Assess seller credibility, consistency, listing history and red flags where data is available.

ECONOMICS:
- Use the supplied EUR FX and Luxury Hunter imported/landed cost. Do not invent another exchange rate or landed cost.
- Estimate conservative European resale using realistic market positioning.
- Liquidity: HIGH / MEDIUM / LOW.
- STRONG BUY: normally >€400 conservative net profit, correct model/size, adequate liquidity and LOW/MEDIUM authenticity risk.
- BUY: approximately €300–400 conservative net profit.
- WATCH: approximately €200–300, or potentially >€300 when verification is still needed.
- REJECT: <€200 known margin, wrong model/size, HIGH authenticity risk, severe condition, poor seller or weak liquidity.
- Missing information should generally lead to WATCH rather than REJECT when the listing could still be attractive.

OPPORTUNITY SCORE:
Approximate weighting: 30% profit, 20% liquidity, 20% authenticity confidence, 10% condition, 10% seller, 10% acquisition attractiveness.
75+ is alert-worthy.`;

const FENDI = `TARGET: Fendi Baguette handbags suitable for resale in Europe.

ACCEPT:
- Authentic Fendi Baguette bags.
- Vintage and modern Baguette versions.
- Shoulder Baguette models in commercially relevant sizes.
- Leather, canvas, Zucca/FF monogram, jacquard and desirable special editions can all be considered.
- Vintage pieces are especially interesting when condition, authenticity confidence and acquisition price are attractive.

PRIORITIZE:
- Classic recognizable Baguette silhouette.
- Zucca / FF monogram.
- Neutral, brown, black and commercially liquid colours.
- Good vintage condition with usable strap and closure.
- Original hardware and recognizable Fendi details.
- Pieces with strong European resale demand.

REJECT:
- Nano / micro charm-sized bags unless economics are exceptionally strong.
- Fendi Peekaboo, Spy, Mama Baguette if clearly not a standard Baguette target, Kan I, Sunshine, First or unrelated models.
- Generic bags incorrectly tagged as Baguette.
- Severe structural damage, broken straps or unusable closures unless price leaves exceptional restoration margin.
- HIGH authenticity risk.

AUTHENTICITY:
Evaluate logo, FF pattern alignment where applicable, hardware, stitching, serial/authentication details, shape, materials and seller consistency.
Never certify authenticity from photos.
HIGH authenticity risk = REJECT.

CONDITION:
Distinguish acceptable vintage patina from deterioration.
Check corners, strap, interior, hardware, closure, canvas/leather wear and previous repairs.

ECONOMICS:
Use the supplied landed cost only.
Estimate conservative European resale.
Target minimum €300–400 net profit where possible.
STRONG BUY generally requires >€400 conservative net profit plus LOW/MEDIUM authenticity risk and good liquidity.
BUY around €300–400.
WATCH when potentially interesting but verification is still required.
REJECT when known margin is poor, model is wrong or authenticity risk is HIGH.`;

const CHLOE = `TARGET: Chloé Paddington handbags, especially the iconic vintage padlock model.

ACCEPT:
- Genuine Chloé Paddington.
- Classic leather Paddington satchel / shoulder bag.
- Commercially relevant vintage Paddington variations.
- Original heavy padlock and key are strongly preferred but missing accessories do not automatically require REJECT if economics remain attractive.

PRIORITIZE:
- Iconic classic Paddington silhouette.
- Medium / standard commercially recognizable sizes.
- Brown, tan, cognac, black, cream and other wearable colours.
- Supple leather with attractive vintage character.
- Complete padlock, key and hardware.
- Strong early-2000s/Y2K appearance.

REJECT:
- Chloé Silverado.
- Edith.
- Paraty.
- Marcie.
- Drew.
- Faye.
- Paddington-inspired or generic padlock bags.
- Extremely small versions with weak resale unless economics clearly justify them.
- HIGH authenticity risk.
- Major leather cracking, structural failure or missing essential components when restoration destroys the margin.

CONDITION:
Paddington leather can show natural softness, creasing and vintage patina.
Do not confuse normal vintage leather character with severe deterioration.
Inspect handles, corners, zipper, padlock, lining and leather dryness.

AUTHENTICITY:
Analyze branding, padlock, hardware, stitching, leather, serial/date details where visible and seller credibility.
Never certify authenticity.
HIGH risk = REJECT.

ECONOMICS:
Target attractive Y2K resale opportunity in Europe.
Use supplied landed cost.
Prefer €300–400+ conservative net profit.
WATCH instead of REJECT if the bag appears promising but authenticity, exact condition or accessories still need verification.`;

const common = {
  enabled:true,
  sources:['xianyu','bunjang','buyee'],
  analyze_images:true,
  max_pages:2,
  max_items:20,
  personal_only:false,
  free_shipping:false,
  region:null,
  account_state_file:null,
  account_strategy:'auto',
  decision_mode:'ai',
  keyword_rules:[],
  xianyu_queries:[],
  bunjang_queries:[],
  japan_queries:[],
  notify_decisions:['STRONG BUY','BUY'],
  notify_min_score:75,
  notify_min_profit_eur:250,
  notify_max_items:8,
  notify_only_new:true
};

const email = process.env.RESTORE_EMAIL || '';

const tasks = [
  {
    ...common,
    task_name:'Balenciaga Le City',
    product_query:'Balenciaga Le City',
    description:BALENCIAGA,
    min_eur:150,
    max_eur:900,
    new_publish_option:'7天内发布',
    interval_minutes:180,
    run_if_missed:true,
    email_enabled:!!email,
    email_to:email || null
  },
  {
    ...common,
    task_name:'Fendi Baguette',
    product_query:'Fendi Baguette',
    description:FENDI,
    min_eur:120,
    max_eur:1000,
    new_publish_option:'1天内发布',
    interval_minutes:null,
    cron:null,
    run_if_missed:false,
    email_enabled:false,
    email_to:null
  },
  {
    ...common,
    task_name:'Chloe Paddington',
    product_query:'Chloe Paddington',
    description:CHLOE,
    min_eur:80,
    max_eur:600,
    new_publish_option:'1天内发布',
    interval_minutes:null,
    cron:null,
    run_if_missed:false,
    email_enabled:false,
    email_to:null
  }
];

for(let i=0;i<60;i++){
  try{ await api('GET','/api/status'); break; }
  catch{
    if(i===59) throw new Error('Luxury Hunter did not start in 60 seconds');
    await sleep(1000);
  }
}

const existing=(await api('GET','/api/tasks')).tasks||[];

for(const task of tasks){
  const old=existing.find(x=>x.task_name===task.task_name);
  if(old){
    await api('PATCH',`/api/tasks/${old.id}`,task);
    console.log(`UPDATED: ${task.task_name}`);
  }else{
    await api('POST','/api/tasks',task);
    console.log(`CREATED: ${task.task_name}`);
  }
}
