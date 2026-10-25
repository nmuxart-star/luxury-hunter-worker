import fs from 'node:fs';
import path from 'node:path';

export function xianyuAccountFiles({primaryFile='',accountDir='' }={}){
  const files=[];
  const seen=new Set();
  const add=file=>{
    if(!file)return;
    try{
      const full=fs.realpathSync(file);
      if(!fs.statSync(full).isFile()||seen.has(full))return;
      const state=JSON.parse(fs.readFileSync(full,'utf8'));
      if(!Array.isArray(state?.cookies))return;
      seen.add(full);
      files.push(full);
    }catch{}
  };
  add(primaryFile);
  if(accountDir&&fs.existsSync(accountDir)){
    for(const name of fs.readdirSync(accountDir).filter(name=>name.endsWith('.json')).sort()){
      add(path.join(accountDir,name));
    }
  }
  return files;
}

export function availableXianyuAccounts(files,{preferred=null,failed=new Map(),fixed=null}={}){
  const ordered=fixed?files.filter(file=>file===fixed):[
    ...(preferred&&files.includes(preferred)?[preferred]:[]),
    ...files.filter(file=>file!==preferred)
  ];
  return ordered.filter(file=>{
    const failedMtime=failed.get(file);
    if(failedMtime===undefined)return true;
    try{return fs.statSync(file).mtimeMs!==failedMtime;}catch{return false;}
  });
}

export function accountLabel(file){
  return file?path.basename(file,'.json'):'sin sesión';
}

export async function tryXianyuAccounts({files,preferred=null,failed=new Map(),fixed=null,search}){
  const candidates=availableXianyuAccounts(files,{preferred,failed,fixed});
  const attempts=files.length||fixed?candidates:[null];
  const expired=[];
  let result=null;
  for(const file of attempts){
    result=await search(file);
    if(result?.login&&file){
      try{failed.set(file,fs.statSync(file).mtimeMs);}catch{}
      expired.push(accountLabel(file));
      continue;
    }
    return {result,usedFile:file,expired};
  }
  return {result:result||{login:true,where:'No quedan cuentas disponibles'},usedFile:null,expired};
}
