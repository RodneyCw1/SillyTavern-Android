
import fs from 'node:fs';import fsp from 'node:fs/promises';import path from 'node:path';import http from 'node:http';import {once} from 'node:events';import assert from 'node:assert/strict';import puppeteer from 'puppeteer-core';
const root=path.resolve(import.meta.dirname,'..'), cdp=process.env.ST_TEST_CDP;let calls=0;
const model=http.createServer(async(req,res)=>{
    let text='';for await(const part of req) text+=part;
    const body=JSON.parse(text||'{}');
    if(!req.url.includes('chat/completions')){res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'mock'}]}));return;}
    calls++; const output='回复验证'+calls+'：中文和emoji😀';
    if(body.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: '+JSON.stringify({choices:[{delta:{content:output.slice(0,5)}}]})+'\n\n');setTimeout(()=>res.end('data: '+JSON.stringify({choices:[{delta:{content:output.slice(5)},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n'),400);}
    else{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:output},finish_reason:'stop'}],usage:{total_tokens:10}}));}
}).listen(17616,'127.0.0.1');await once(model,'listening');
const browser=cdp?await puppeteer.connect({browserURL:cdp,defaultViewport:null}):await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,userDataDir:path.join(root,'.local/plugin-test'),args:['--no-first-run']});
const report={environment:cdp||'desktop Chrome against isolated Android server',checks:[]};
try{
    const page=cdp?(await browser.pages()).find(p=>p.url().includes('17614')):await browser.newPage();
    if(!cdp){await browser.setCookie({name:'st_android_auth',value:fs.readFileSync(path.join(root,'.local/desktop-data/session-token'),'utf8'),domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Strict'});await page.goto('http://127.0.0.1:17614/',{waitUntil:'networkidle2',timeout:60000});}
    await page.waitForFunction(()=>window.TavernHelper&&document.querySelector('#opf-launcher'));
    await page.evaluate(async()=>{
        document.querySelectorAll('dialog[open]').forEach(d=>d.close());
        const ctx=SillyTavern.getContext();await ctx.getCharacters();await ctx.selectCharacterById(SillyTavern.getContext().characters.findIndex(c=>c.avatar==='安卓验证.png'));
        while(!SillyTavern.getContext().chat.length) await new Promise(r=>setTimeout(r,100));
        $('#main_api').val('openai').trigger('change');
        Object.assign(ctx.chatCompletionSettings,{chat_completion_source:'custom',custom_url:'http://127.0.0.1:17616/v1',custom_model:'mock',stream_openai:false});
        ctx.extensionSettings.openingPresetForge.summary.enabled=false;
        window.__received=0;ctx.eventSource.on(ctx.eventTypes.MESSAGE_RECEIVED,()=>window.__received++);
    });
    for(const stream of [false,true]){
        const result=await page.evaluate(async(stream)=>{
            const ctx=SillyTavern.getContext();ctx.chatCompletionSettings.stream_openai=stream;
            const core=await import('/script.js');core.setOnlineStatus('mock');
            const before=ctx.chat.length;const eventsBefore=window.__received;
            $('#send_textarea').val('安卓生成验证');
            await ctx.generate('normal');
            const after=SillyTavern.getContext();await after.saveChat();
            return {stream,before,after:after.chat.length,text:after.chat.at(-1)?.mes,extra:after.chat.at(-1)?.extra,eventCount:window.__received-eventsBefore};
        },stream);
        console.log(JSON.stringify(result));
        assert.equal(result.after,result.before+2);
        assert.match(result.text,/回复验证.*中文和emoji😀/);
        assert.equal(result.eventCount,1);
        assert.equal(result.extra.android_job_complete,true,'A fully saved reply must be acknowledged');
        report.checks.push(result);
    }
    assert.equal(calls,2);
    await fsp.writeFile(path.join(root,'docs/generation-ui'+(cdp?'-android':'')+'.json'),JSON.stringify(report,null,2));
}finally{model.closeAllConnections();model.close();cdp?browser.disconnect():await browser.close();}
