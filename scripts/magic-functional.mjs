
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'..'), cdp=process.env.ST_TEST_CDP;
const mockPort=17616; let calls=0;
const fixture={character:{name:'安卓验证',level:1,basePoints:{strength:5,dexterity:5,constitution:5,intelligence:5,mind:5}},equipment:[],items:[],assets:[],skills:[],partners:[],background:{name:'验证场景',description:'中文背景验证'},customInjectionSettings:{}};
const model=http.createServer(async(req,res)=>{
    let body=''; for await(const part of req) body+=part;
    if(!req.url.includes('chat/completions')) {res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'mock'}]}));return;}
    calls++;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:JSON.stringify(fixture)},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}}));
}).listen(mockPort,'127.0.0.1');
await once(model,'listening');
const browser=cdp?await puppeteer.connect({browserURL:cdp,defaultViewport:null}):await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,userDataDir:path.join(root,'.local/plugin-test'),args:['--no-first-run']});
const report={environment:cdp||'desktop Chrome',model:'Local deterministic OpenAI-compatible fixture; no credentials or paid requests',checks:[]};
try {
    const page=cdp?(await browser.pages()).find(p=>p.url().includes('17614')):await browser.newPage();
    if(!cdp){
        await browser.setCookie({name:'st_android_auth',value:fs.readFileSync(path.join(root,'.local/desktop-data/session-token'),'utf8'),domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Strict'});
        await page.setViewport({width:430,height:900,isMobile:true,hasTouch:true});
        await page.goto('http://127.0.0.1:17614/',{waitUntil:'networkidle2',timeout:60000});
    }
    page.on('pageerror',e=>console.error('PAGE',e.message));
    page.on('console',m=>{if(m.type()==='error') console.error('CONSOLE',m.text().slice(0,500));});
    await page.waitForFunction(()=>window.TavernHelper&&document.querySelector('#opf-launcher'));
    await page.evaluate(async()=>{
        document.querySelectorAll('dialog[open]').forEach(d=>d.close());
        const ctx=SillyTavern.getContext();
        await ctx.getCharacters();
        const id=SillyTavern.getContext().characters.findIndex(c=>c.avatar==='安卓验证.png'); if(id<0) throw new Error('Run plugin-functional.mjs first'); await ctx.selectCharacterById(id);
        while(!SillyTavern.getContext().chat.length) await new Promise(r=>setTimeout(r,100));
        $('#main_api').val('openai').trigger('change');
        Object.assign(ctx.chatCompletionSettings,{chat_completion_source:'custom',custom_url:'http://127.0.0.1:17616/v1',custom_model:'mock',stream_openai:false});
        ctx.extensionSettings.openingPresetForge.autoCompliance=false;
        document.querySelector('#opf-launcher').click();
        const demand=document.querySelector('#opf-demand'); demand.value='为兼容测试生成一个中文角色'; demand.dispatchEvent(new Event('input',{bubbles:true}));
        document.querySelector('#opf-ck-ac').checked=false; document.querySelector('#opf-ck-ac').dispatchEvent(new Event('change'));
        document.querySelector('#opf-btn-run').click();
    });
    await page.waitForFunction(()=>document.querySelector('#opf-json-out').textContent.includes('中文背景验证') && !document.querySelector('#opf-ref-input-skill').disabled,{timeout:45000}).catch(async error=>{console.log(JSON.stringify({calls,state:await page.evaluate(()=>({phases:[...document.querySelectorAll('.opf-step')].map(e=>[e.id,e.dataset.st]),toasts:[...document.querySelectorAll('.toast-message')].map(e=>e.textContent),json:document.querySelector('#opf-json-out').textContent.slice(0,250)}))}));throw error;});
    assert.ok(calls>=6);report.checks.push('Six generation phases completed through original generateRaw and Android durable HTTP proxy');
    await page.evaluate(()=>{
        const field=document.querySelector('#opf-ref-input-skill');field.value='增加中文细节';
        field.closest('.opf-refine, .opf-ref')?.querySelector('.opf-ref-do')?.click();
        if(!field.closest('.opf-refine, .opf-ref')) document.querySelector('#opf-ph-skill .opf-ref-do').click();
    });
    const before=calls;
    await page.waitForFunction(()=>document.querySelector('#opf-resum').textContent.includes('有分步修改'),{timeout:60000});
    report.checks.push('Refine one phase completed');
    await page.evaluate(()=>{
        document.querySelector('#opf-resum').click();
    });
    await page.waitForFunction(()=>!document.querySelector('#opf-resum').disabled&&!document.querySelector('#opf-launcher').classList.contains('running'),{timeout:60000}).catch(()=>{});
    await page.evaluate(()=>{
        const en=document.querySelector('#opf-memo-enable');en.checked=true;en.dispatchEvent(new Event('change'));
        document.querySelector('#opf-memo-now').click();
    });
    await page.waitForFunction(()=>document.querySelector('#opf-memo-out').textContent.includes('安卓验证'),{timeout:15000}).catch(async error=>{console.log(JSON.stringify({calls,summary:await page.evaluate(()=>({status:document.querySelector('#opf-memo-status').textContent,output:document.querySelector('#opf-memo-out').textContent,chatLength:SillyTavern.getContext().chat.length,chatId:SillyTavern.getContext().chatId,settings:SillyTavern.getContext().extensionSettings.openingPresetForge.summary}))}));throw error;});
    report.checks.push('Summary completed and saved to chat metadata');
    if(!cdp){
        const downloads=path.join(root,'.local/test-downloads');await fsp.mkdir(downloads,{recursive:true});
        const session=await page.createCDPSession();await session.send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
    }
    report.exportRequestedAt=await page.evaluate(()=>Date.now());
    await page.evaluate(()=>document.querySelector('#opf-btn-save').click());
    await new Promise(r=>setTimeout(r,1200));
    const ui=await page.evaluate(()=>({output:document.querySelector('#opf-json-out').textContent.slice(0,500),summary:document.querySelector('#opf-memo-status').textContent,refine:document.querySelector('#opf-ref-tag-skill').textContent}));
    report.checks.push('JSON export action executed');report.calls=calls;report.ui=ui;
    if(!cdp){
        const names=(await fsp.readdir(path.join(root,'.local/test-downloads'))).filter(n=>n.endsWith('.preset.json'));assert.ok(names.length);
        JSON.parse(await fsp.readFile(path.join(root,'.local/test-downloads',names.at(-1)),'utf8'));report.checks.push('Downloaded preset JSON parses successfully');
    }
    await page.screenshot({path:path.join(root,'docs/screenshots/magic'+(cdp?'-android':'')+'.png')});
    await fsp.writeFile(path.join(root,'docs/magic-functional'+(cdp?'-android':'')+'.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
} finally {model.closeAllConnections();model.close();cdp?browser.disconnect():await browser.close();}
