import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { releaseConfig } from './release-version.mjs';
const root=path.resolve(import.meta.dirname,'..');
export function identity(runNumber) {
    const n=Number(runNumber);
    if(!Number.isSafeInteger(n)||n<1||n>2100000000-releaseConfig.versionCodeOffset)throw Error('Invalid release run number');
    return {versionName:releaseConfig.baseVersion+'+build.'+n,versionCode:releaseConfig.versionCodeOffset+n};
}
export function shouldPromote(code,latest){return !latest||code>latest.versionCode;}
export async function publishRelease(info,files,github){
    const repo=releaseConfig.repository,tag='v'+info.versionName;
    let release;
    try{release=await github.api('repos/'+repo+'/releases/tags/'+encodeURIComponent(tag));}
    catch(error){if(error.status!==404)throw error;}
    if(!release){
        release=await github.api('repos/'+repo+'/releases','POST',{tag_name:tag,target_commitish:info.commit,
            name:info.versionName,body:info.notes,draft:true,prerelease:false,make_latest:'false'});
    }
    let reference;
    try { reference=await github.api('repos/'+repo+'/git/ref/tags/'+encodeURIComponent(tag)); }
    catch (error) {
        if(error.status!==404)throw error;
        reference=await github.api('repos/'+repo+'/git/refs','POST',{ref:'refs/tags/'+tag,sha:info.commit});
    }
    if(reference.object.sha!==info.commit)throw Error('Release tag points at different source; refusing to overwrite');
    if(release.draft){
        await github.upload(tag,files);
        release=await github.api('repos/'+repo+'/releases/'+release.id);
        for(const file of files){
            const bytes=await fs.readFile(file),hash='sha256:'+crypto.createHash('sha256').update(bytes).digest('hex');
            const asset=release.assets.find(x=>x.name===path.basename(file));
            if(!asset||asset.state!=='uploaded'||asset.size!==bytes.length||asset.digest!==hash)throw Error('Uploaded release asset verification failed: '+path.basename(file));
        }
        let latest;
        try{
            const previous=await github.api('repos/'+repo+'/releases/latest');
            const previousTag=previous.tag_name;
            if(previousTag.startsWith('v')) {
                const match=/\+build\.(\d+)$/.exec(previousTag);
                if(match)latest={versionCode:releaseConfig.versionCodeOffset+Number(match[1])};
                else throw Error('Latest release has an unsupported version format');
            }
        }catch(error){if(error.status!==404)throw error;}
        release=await github.api('repos/'+repo+'/releases/'+release.id,'PATCH',{
            draft:false,make_latest:shouldPromote(info.versionCode,latest)?'true':'false'});
    } else {
        const expectedNames=files.map(file=>path.basename(file));
        if(expectedNames.some(name=>!release.assets.some(asset=>asset.name===name&&asset.state==='uploaded')))throw Error('Published release is incomplete');
    }
    const marker='<!-- st-release:'+tag+' -->';
    const issues=await github.api('repos/'+repo+'/issues?state=all&labels=release&per_page=100', 'GET', undefined, true);
    if(!issues.some(issue=>!issue.pull_request&&issue.body?.includes(marker))){
        try{await github.api('repos/'+repo+'/labels','POST',{name:'release',color:'0E8A16',description:'APK version announcements'});}
        catch(error){if(error.status!==422)throw error;}
        const asset=release.assets.find(x=>x.name.endsWith('.apk'));
        await github.api('repos/'+repo+'/issues','POST',{title:'[发布] '+info.versionName,labels:['release'],
            body:marker+'\n\n'+info.notes+'\n\n[下载签名 APK]('+asset.browser_download_url+') · [Release 与校验文件]('+release.html_url+')\n\n旧版首次需手动覆盖安装；后续可点击“⋮”应用控制菜单，再选择“更新”。覆盖安装保留已有角色卡、世界书、聊天、设置与插件。'});
    }
    return release.html_url;
}
function cliGithub(){
    function gh(args){return execFileSync(process.env.GH_BINARY||'gh',args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024,stdio:['pipe','pipe','pipe']});}
    return {
        async api(route,method='GET',body,paginate=false){
            const args=['api',route,'--method',method];
            if(body){
                const file=path.join(root,'.local','github-request-'+crypto.randomUUID()+'.json');
                await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(body));
                args.push('--input',file);
                try{return JSON.parse(gh(args));}catch(error){const status=/HTTP (\d{3})/.exec(error.stderr?.toString()||'');error.status=Number(status?.[1]);throw error;}
                finally{await fs.rm(file,{force:true});}
            }
            if(paginate)args.push('--paginate','--slurp');
            try{const value=JSON.parse(gh(args));return paginate?value.flat():value;}
            catch(error){const status=/HTTP (\d{3})/.exec(error.stderr?.toString()||'');error.status=Number(status?.[1]);throw error;}
        },
        async upload(tag,files){gh(['release','upload',tag,...files,'--clobber','--repo',releaseConfig.repository]);},
    };
}
async function main(){
    const action=process.argv[2];
    if(action==='version'){
        const info=identity(process.env.GITHUB_RUN_NUMBER);
        if(process.env.GITHUB_ENV)await fs.appendFile(process.env.GITHUB_ENV,'ST_ANDROID_VERSION_NAME='+info.versionName+'\nST_ANDROID_VERSION_CODE='+info.versionCode+'\n');
        console.log(JSON.stringify(info));return;
    }
    if(action!=='publish')throw Error('Usage: node scripts/release.mjs version|publish');
    const versionName=process.env.ST_ANDROID_VERSION_NAME,versionCode=Number(process.env.ST_ANDROID_VERSION_CODE);
    const allocated=identity(process.env.GITHUB_RUN_NUMBER);
    if(versionName!==allocated.versionName||versionCode!==allocated.versionCode)throw Error('Release version does not match its CI run');
    const commit=process.env.GITHUB_SHA;
    if(!/^[a-f0-9]{40}$/.test(commit||''))throw Error('Release source commit missing');
    const apk=path.join(root,'releases','SillyTavern-Android-'+versionName+'-release.apk');
    const hash=crypto.createHash('sha256');let size=0;
    const {createReadStream}=await import('node:fs');
    for await(const chunk of createReadStream(apk)){hash.update(chunk);size+=chunk.length;}
    const sha256=hash.digest('hex');
    const audit=JSON.parse(await fs.readFile(path.join(root,'releases/apk-audit.json'),'utf8'));
    if(!audit.passed||audit.appVersion!==versionName||audit.plugins.length)throw Error('APK audit failed or third-party preinstallation found');
    const subject=execFileSync('git',['show','-s','--format=%s',commit],{cwd:root,encoding:'utf8',windowsHide:true}).trim();
    const notes='SillyTavern '+versionName+'\n\n'+subject+'\n\n原生 SillyTavern 1.19.0；不预装第三方插件、角色卡或世界书。更新保留已有个人内容。';
    const info={schemaVersion:1,versionName,versionCode,packageName:releaseConfig.packageName,minSdk:releaseConfig.minSdk,
        apkUrl:'https://github.com/'+releaseConfig.repository+'/releases/download/'+encodeURIComponent('v'+versionName)+'/'+encodeURIComponent(path.basename(apk)),
        size,sha256,signingSha256:releaseConfig.signingSha256,commit,sourceHash:audit.sourceHash,notes};
    const manifest=path.join(root,'releases/update.json'),checksums=path.join(root,'releases/checksums.txt');
    await fs.writeFile(manifest,JSON.stringify(info,null,2)+'\n');
    await fs.writeFile(checksums,sha256+'  '+path.basename(apk)+'\n');
    console.log(await publishRelease(info,[apk,manifest,checksums,path.join(root,'releases/apk-audit.json')],cliGithub()));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
    main().catch(error=>{console.error('Release failed: '+error.message);process.exitCode=1;});
}
