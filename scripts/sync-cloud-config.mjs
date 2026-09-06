import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cloudDir=path.join(root,'cloud');
const jsonPath=path.join(cloudDir,'config.json');
const encPath=path.join(cloudDir,'config.enc');
const prepareOnly=process.argv.includes('--prepare-only');
const keychainService='LuxuryHunterConfigPassword';

function run(command,args=[],options={}){
  return execFileSync(command,args,{
    cwd:root,
    encoding:'utf8',
    maxBuffer:20*1024*1024,
    ...options
  });
}

function getPassword(){
  const envPassword=String(
    process.env.LUXURY_CONFIG_PASSWORD||''
  ).trim();

  if(envPassword)return envPassword;

  if(process.platform==='darwin'){
    try{
      return run('security',[
        'find-generic-password',
        '-a',
        os.userInfo().username,
        '-s',
        keychainService,
        '-w'
      ]).trim();
    }catch{}
  }

  throw new Error(
    'No encuentro LUXURY_CONFIG_PASSWORD. '+
    'Configura primero el acceso en el Keychain local.'
  );
}

function git(args,options={}){
  return run('git',args,options);
}

fs.mkdirSync(cloudDir,{recursive:true});

run(process.execPath,[
  path.join(root,'scripts','export-cloud-config.mjs')
]);

if(!fs.existsSync(jsonPath)){
  throw new Error('cloud/config.json no fue generado.');
}

const config=JSON.parse(
  fs.readFileSync(jsonPath,'utf8')
);

const password=getPassword();

const env={
  ...process.env,
  LUXURY_CONFIG_PASSWORD:password
};

run('openssl',[
  'enc',
  '-aes-256-cbc',
  '-salt',
  '-pbkdf2',
  '-in',
  jsonPath,
  '-out',
  encPath,
  '-pass',
  'env:LUXURY_CONFIG_PASSWORD'
],{env});

const verifyPath=path.join(
  os.tmpdir(),
  `luxury-hunter-config-${process.pid}.json`
);

try{
  run('openssl',[
    'enc',
    '-d',
    '-aes-256-cbc',
    '-pbkdf2',
    '-in',
    encPath,
    '-out',
    verifyPath,
    '-pass',
    'env:LUXURY_CONFIG_PASSWORD'
  ],{env});

  JSON.parse(
    fs.readFileSync(verifyPath,'utf8')
  );
}finally{
  try{fs.unlinkSync(verifyPath)}catch{}
}

try{fs.unlinkSync(jsonPath)}catch{}

console.log(
  `Cloud config preparada: ${(config.tasks||[]).length} tareas`
);

for(const task of config.tasks||[]){
  console.log(
    `  ${task.task_name} | `+
    `${task.new_publish_option||'sin filtro temporal'}`
  );
}

if(prepareOnly){
  console.log(
    'OK - configuración preparada sin commit ni push'
  );
  process.exit(0);
}

if(
  String(process.env.GITHUB_ACTIONS||'')
    .toLowerCase()==='true'
){
  console.log(
    'GitHub Actions detectado: auto-sync local omitido.'
  );
  process.exit(0);
}

const branch=git([
  'rev-parse',
  '--abbrev-ref',
  'HEAD'
]).trim();

if(branch!=='main'){
  throw new Error(
    `Auto-sync requiere la rama main; actual=${branch}`
  );
}

git([
  'fetch',
  '--quiet',
  'origin',
  'main'
]);

try{
  git([
    'merge-base',
    '--is-ancestor',
    'origin/main',
    'HEAD'
  ]);
}catch{
  throw new Error(
    'origin/main ha divergido de tu rama local. '+
    'No hago push automático para evitar conflictos.'
  );
}

git([
  'add',
  '--',
  'cloud/config.enc'
]);

let hasConfigChange=true;

try{
  git([
    'diff',
    '--cached',
    '--quiet',
    '--',
    'cloud/config.enc'
  ]);
  hasConfigChange=false;
}catch(e){
  if(e?.status!==1)throw e;
}

if(!hasConfigChange){
  console.log(
    'OK - GitHub ya tiene esta configuración'
  );
  process.exit(0);
}

git([
  'commit',
  '-m',
  'Sync platform task configuration',
  '--',
  'cloud/config.enc'
]);

git([
  'push',
  'origin',
  'main'
],{
  stdio:'inherit'
});

console.log(
  'OK - configuración de la plataforma sincronizada con GitHub'
);
