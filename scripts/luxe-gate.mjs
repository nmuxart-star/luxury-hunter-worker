// FILTRO DEL CHAT «ALTAGAMA LUXE» (regla de Nil, 17-11-2026): ese chat recibe solo lo que de verdad compensa, más exigente que el chat
// principal (que sigue recibiéndolo todo). Un aviso entra en Luxe si:
//   · el riesgo de autenticidad no es alto;
//   · el beneficio limpio sobre el coste puesto es al menos minMarginPct (30 %, lo que busca Nil; antes los avisos suaves entraban desde el 20 %);
//   · si el Resumen de precios conoce el modelo (≥ minN fichas), el precio no supera el máximo de compra para el 30 % de margen;
//   · un aviso «sin pronóstico» solo entra si el Resumen lo conoce y el precio está dentro de ese máximo (sin Resumen no hay con qué
//     comprobar que sea rentable).
// Función pura: el servidor le pasa lo que sabe del anuncio y del Resumen.
export function luxeVerdict({risk='',price,netLow=null,landed=null,marginPct=null,noRefs=false,summary=null,minMarginPct=30,minN=5}={}){
  if(String(risk).toUpperCase()==='HIGH')return {ok:false,why:'riesgo alto de autenticidad'};
  const p=Number(price);
  const known=summary&&summary.target>0&&summary.n>=minN;
  if(known&&p>summary.target)return {ok:false,why:`precio ${Math.round(p)} € por encima del máximo del Resumen (${summary.target} € para ${summary.margin} % de margen)`};
  if(noRefs)return known?{ok:true,why:''}:{ok:false,why:'sin pronóstico y sin segmento en el Resumen con el que comprobarlo'};
  const l=Number(landed),n=Number(netLow);
  const margins=[Number.isFinite(Number(marginPct))&&marginPct!==null?Number(marginPct):null,l>0&&Number.isFinite(n)&&netLow!==null?n/l*100:null].filter(x=>x!==null);
  if(margins.length){
    const margin=Math.min(...margins);                     // el más prudente de los dos
    if(margin<minMarginPct)return {ok:false,why:`margen ${margin.toFixed(0)} % por debajo del ${minMarginPct} % exigido en Luxe`};
  }else if(!known)return {ok:false,why:'sin margen calculado ni Resumen'};
  return {ok:true,why:''};
}

// Reglas de precio demasiado bajo para ser original en Xianyu (réplicas): mínimos por marca y proporción mínima sobre el Resumen.
// brandFloors: [{re, min, label}]; summaryRef: precio de referencia del Resumen (o null) con summaryN fichas.
export function tooCheapVerdict({title='',price,brandFloors=[],summaryRef=null,summaryN=0,minShare=0.30,minN=5}={}){
  const p=Number(price);
  if(!(p>0))return null;
  const t=String(title);
  for(const f of brandFloors){
    if(f.re.test(t)&&p<f.min)return {term:`${f.label} ${Math.round(p)}<${f.min}`,reason:`${f.label} a ${Math.round(p)} € en Xianyu: por debajo de ${f.min} € casi siempre es réplica (con caja y papeles incluidos). Descartado.`};
  }
  if(summaryRef>0&&summaryN>=minN&&p<summaryRef*minShare){
    const floor=Math.round(summaryRef*minShare);
    return {term:`${Math.round(p)}<${floor}`,reason:`Precio irrealmente bajo para un original: ${Math.round(p)} € frente a un mínimo de ${floor} € (${Math.round(minShare*100)} % del precio de referencia del Resumen). En Xianyu suele ser réplica.`};
  }
  return null;
}
