
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const root = path.resolve(import.meta.dirname, '..');
const cdp = process.env.ST_TEST_CDP;
const browser = cdp ? await puppeteer.connect({browserURL:cdp,defaultViewport:null}) : await puppeteer.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true,userDataDir:path.join(root,'.local/plugin-test'),args:['--no-first-run']});
const report = {testedAt:new Date().toISOString(),environment:cdp || 'desktop Chrome',checks:[]};
try {
    const page = cdp ? (await browser.pages()).find(p=>p.url().includes('17614')) : await browser.newPage();
    assert.ok(page,'SillyTavern page must be open');
    if (!cdp) {
        await browser.setCookie({name:'st_android_auth',value:fs.readFileSync(path.join(root,'.local/desktop-data/session-token'),'utf8'),domain:'127.0.0.1',path:'/',httpOnly:true,sameSite:'Strict'});
        await page.setViewport({width:430,height:900,isMobile:true,hasTouch:true});
        await page.goto('http://127.0.0.1:17614/',{waitUntil:'networkidle2',timeout:60000});
    }
    await page.waitForFunction(()=>window.TavernHelper && window.EjsTemplate && document.querySelector('#opf-launcher'),{timeout:60000});
    const helperVersion=await page.evaluate(async()=>({runtime:TavernHelper.getTavernHelperVersion(),manifest:(await(await fetch('/scripts/extensions/third-party/JS-Slash-Runner/manifest.json')).json()).version}));
    if(process.env.ST_EXPECT_HELPER) { assert.equal(helperVersion.runtime,process.env.ST_EXPECT_HELPER); assert.equal(helperVersion.manifest,process.env.ST_EXPECT_HELPER); }
    report.helperVersion=helperVersion;
    await page.evaluate(async()=>{
        document.querySelectorAll('dialog[open]').forEach(d=>d.close());
        const ctx=SillyTavern.getContext();
        if (!ctx.characters.some(c=>c.avatar==='安卓验证.png')) {
            const response=await fetch('/api/characters/create',{method:'POST',headers:ctx.getRequestHeaders(),body:JSON.stringify({ch_name:'安卓验证',file_name:'安卓验证',description:'Test fixture only',first_mes:'你好，安卓。'})});
            if(!response.ok) throw new Error(await response.text());
        }
        await ctx.getCharacters();
        const id=SillyTavern.getContext().characters.findIndex(c=>c.avatar==='安卓验证.png');
        await ctx.selectCharacterById(id);
    });
    await page.waitForFunction(()=>SillyTavern.getContext().chat.length>0);
    report.checks.push({name:'Create and open character with Chinese filename',passed:true});
    const basic=await page.evaluate(async()=>{
        const helper=window.TavernHelper;
        const before=helper.getVariables({type:'global'});
        helper.insertOrAssignVariables({android_test:'中文变量✓'},{type:'global'});
        const variables=helper.getVariables({type:'global'}).android_test;
        const formatted=helper.formatAsTavernRegexedString('{{get_global_variable::android_test}}', 'ai_output', 'prompt');
        const template=await window.EjsTemplate.evalTemplate('安卓<%= value + 2 %>',{value:40});
        helper.replaceVariables(before,{type:'global'});
        return {variables,formatted,template,helperMethods:Object.keys(helper).filter(k=>/format|script|macro/i.test(k))};
    });
    assert.equal(basic.variables,'中文变量✓');
    assert.equal(basic.template,'安卓42');
    if(basic.formatted !== null) assert.match(basic.formatted,/中文变量/);
    report.checks.push({name:'Helper variables and macro rendering; Prompt Template EJS',...basic});
    await page.evaluate(()=>{
        window.__androidOldScripts=TavernHelper.getScriptTrees({type:'global'});
        TavernHelper.replaceScriptTrees([...window.__androidOldScripts,{type:'script',enabled:true,name:'Android compatibility fixture',id:'b7d52711-8394-404d-bce7-8f54d31c7d30',content:"parent.__androidScriptProof = {iframe: window !== parent, variable: getVariables({type:'global'}), events: typeof eventOn};"}],{type:'global'});
    });
    await page.waitForFunction(()=>window.__androidScriptProof,{timeout:30000});
    const proof=await page.evaluate(()=>{
        const proof=window.__androidScriptProof;
        TavernHelper.replaceScriptTrees(window.__androidOldScripts,{type:'global'});
        delete window.__androidOldScripts; delete window.__androidScriptProof;
        return {iframe:proof.iframe,events:proof.events};
    });
    assert.equal(proof.iframe,true); assert.equal(proof.events,'function');
    report.checks.push({name:'Helper executes a enabled script inside its own iframe with event API',...proof});
    report.checks.push({name:'Magic Compendium UI',...await page.evaluate(()=>({generate:!!document.querySelector('#opf-btn-run'),refine:!!document.querySelector('.opf-ref-do'),summary:!!document.querySelector('#opf-memo-now'),export:!!document.querySelector('#opf-btn-save')}))});
    await fsp.writeFile(path.join(root,process.env.ST_TEST_REPORT || ('docs/plugin-functional'+(cdp?'-android':'')+'.json')),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report,null,2));
} finally { cdp ? browser.disconnect() : await browser.close(); }
