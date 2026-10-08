
import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..');let calls=0;
const model=http.createServer(async(req,res)=>{for await(const part of req){} calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'冷恢复回复：中文验证'},finish_reason:'stop'}]}));}).listen(17616,'127.0.0.1');await once(model,'listening');
const browser=await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,userDataDir:path.join(root,'.local/plugin-test'),args:['--no-first-run']});
try{
 const page=await browser.newPage();page.on('dialog',d=>d.accept());
 await browser.setCookie({name:'st_android_auth',value:fs.readFileSync(path.join(root,'.local/desktop-data/session-token'),'utf8'),domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Strict'});
 async function ready(){
  await page.waitForFunction(()=>window.TavernHelper&&document.querySelector('#opf-launcher'));
  await page.evaluate(async()=>{document.querySelectorAll('dialog[open]').forEach(d=>d.close());const ctx=SillyTavern.getContext();await ctx.getCharacters();await ctx.selectCharacterById(SillyTavern.getContext().characters.findIndex(c=>c.avatar==='安卓验证.png'));while(!SillyTavern.getContext().chat.length)await new Promise(r=>setTimeout(r,100));ctx.extensionSettings.openingPresetForge.summary.enabled=false;});
 }
 await page.goto('http://127.0.0.1:17614/',{waitUntil:'networkidle2',timeout:60000});await ready();
 const jobId=await page.evaluate(async()=>{
  const core=await import('/script.js');await core.sendMessageAsUser('冷恢复验证');
  const ctx=SillyTavern.getContext(),id=crypto.randomUUID();
  const response=await fetch('/api/android/jobs',{method:'POST',headers:ctx.getRequestHeaders(),body:JSON.stringify({id,endpoint:'/api/backends/chat-completions/generate',body:{chat_completion_source:'custom',custom_url:'http://127.0.0.1:17616/v1',model:'mock',messages:[{role:'user',content:'fixture'}],stream:false},context:{type:'normal',chatId:ctx.chatId,avatar:ctx.characters[ctx.characterId].avatar,groupId:null,chatLength:ctx.chat.length,name:'Cold recovery fixture'}})});
  if(!response.ok)throw new Error(await response.text());return id;
 });
 await page.reload({waitUntil:'networkidle2'});await ready();
 await page.waitForFunction(async id=>(await(await fetch('/api/android/jobs/'+id)).json()).state==='complete',{},jobId);
 const before=await page.evaluate(()=>{window.__restoreEvents=0;const ctx=SillyTavern.getContext();ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED,()=>window.__restoreEvents++);return ctx.chat.length;});
 let rejectSave=true;await page.setRequestInterception(true);
 page.on('request',request=>{if(rejectSave&&new URL(request.url()).pathname==='/api/chats/save'){rejectSave=false;request.respond({status:500,contentType:'application/json',body:'{"error":"deliberate save failure fixture"}'});}else request.continue();});
 async function recover(){
  await page.evaluate(async id=>{await STAndroid.showRecovery();document.querySelector('[data-job-id="'+id+'"] button').click();},jobId);
  await page.waitForFunction(id=>[...document.querySelectorAll('[data-job-id="'+id+'"] button')].some(b=>b.textContent==='恢复到原聊天'),{},jobId);
  await page.evaluate(id=>{const button=[...document.querySelectorAll('[data-job-id="'+id+'"] button')].find(b=>b.textContent==='恢复到原聊天');button.id='fixture-restore-button';button.click();},jobId);
  await page.waitForFunction(()=>!document.querySelector('#fixture-restore-button')||!document.querySelector('#fixture-restore-button').disabled);
 }
 await recover();
 const failed=await page.evaluate(async id=>({job:await(await fetch('/api/android/jobs/'+id)).json(),length:SillyTavern.getContext().chat.length,complete:SillyTavern.getContext().chat.at(-1).extra.android_job_complete,events:window.__restoreEvents}),jobId);
 assert.equal(failed.job.acknowledged,false);assert.equal(failed.complete,false);assert.equal(failed.length,before+1);
 await recover();
 const saved=await page.evaluate(async id=>({job:await(await fetch('/api/android/jobs/'+id)).json(),length:SillyTavern.getContext().chat.length,text:SillyTavern.getContext().chat.at(-1).mes,events:window.__restoreEvents}),jobId);
 assert.equal(saved.job.acknowledged,true);assert.equal(saved.length,before+1);assert.equal(saved.events,1);assert.equal(calls,1);
 const report={passed:true,checks:['Reloaded UI recovers a durable reply','Failed chat save keeps recoverable result','Retry saves without duplicate messages, plugin event or model request'],modelCalls:calls,pluginEvents:saved.events};
 await fsp.writeFile(path.join(root,'docs/recovery-ui.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}finally{model.closeAllConnections();model.close();await browser.close();}
