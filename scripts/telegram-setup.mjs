// Configura las alertas por Telegram: pide el token del bot (de @BotFather),
// detecta tu chat ID a partir del último mensaje que le hayas enviado al bot y
// manda un mensaje de prueba. No guarda nada: al final te dice qué secrets poner.
// Uso: npm run telegram:setup
import readline from 'node:readline/promises';

const rl=readline.createInterface({input:process.stdin,output:process.stdout});
const token=(process.env.TELEGRAM_BOT_TOKEN||await rl.question('Pega el token del bot (de @BotFather): ')).trim();
rl.close();
if(!/^\d+:[\w-]{30,}$/.test(token)){
  console.log('Ese token no tiene el formato esperado (números:letras). Revísalo en @BotFather.');
  process.exit(1);
}

const api=async(method,body)=>{
  const r=await fetch(`https://api.telegram.org/bot${token}/${method}`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body||{}),
    signal:AbortSignal.timeout(20000)
  });
  const data=await r.json().catch(()=>({}));
  if(!data.ok)throw new Error(data.description||`HTTP ${r.status}`);
  return data.result;
};

try{
  const me=await api('getMe');
  console.log(`Bot correcto: @${me.username}`);
  const updates=await api('getUpdates',{limit:20});
  const chats=[...new Map(updates.map(u=>u.message?.chat||u.my_chat_member?.chat).filter(Boolean).map(c=>[c.id,c])).values()];
  if(!chats.length){
    console.log(`\nNo encuentro ningún mensaje. Abre Telegram, busca @${me.username}, pulsa "Iniciar" y escríbele "hola". Luego vuelve a ejecutar esto.`);
    process.exit(2);
  }
  const chat=chats[chats.length-1];
  await api('sendMessage',{chat_id:chat.id,text:'✅ Luxury Hunter conectado. Aquí recibirás las alertas de oportunidades.'});
  console.log(`\nMensaje de prueba enviado a ${chat.first_name||chat.title||'tu chat'}.`);
  console.log(`\nTu TELEGRAM_CHAT_ID es: ${chat.id}`);
  console.log('\nAhora guarda los dos secrets (te pedirá el valor de cada uno):');
  console.log('  ~/bin/gh secret set TELEGRAM_BOT_TOKEN --repo nmuxart-star/luxury-hunter-worker');
  console.log('  ~/bin/gh secret set TELEGRAM_CHAT_ID --repo nmuxart-star/luxury-hunter-worker');
}catch(e){
  console.log(`Error de Telegram: ${e.message}`);
  process.exit(1);
}
