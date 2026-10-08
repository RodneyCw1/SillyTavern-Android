import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { getSourceHash } from './source-inventory.mjs';

const rows = [
    ['后端启动、HTTPS、会话与 CSRF', 'http-smoke.json'],
    ['插件安装、更新与失败回退', 'git-integration.json'],
    ['酒馆助手变量、宏、iframe 脚本；EJS 展开', 'plugin-functional.json'],
    ['魔法大典生成、精修、总结、JSON 导出', 'magic-functional.json'],
    ['原聊天界面普通/流式生成', 'generation-ui.json'],
    ['迁移包实际导入与哈希校验', 'migration-verification.json'],
    ['恢复失败后重试', 'recovery-ui.json'],
    ['原生迁移备份与升级保留', 'android-migration-upgrade.json'],
    ['原生导出、剪贴板、键盘与返回键', 'native-ui.json'],
    ['Android 10 原生运行与恢复', 'android-smoke-emulator-5554.json'],
    ['Android 15 / 16 KB 原生运行与恢复', 'android-smoke-emulator-5556.json'],
    ['Android WebView 插件与模板', 'plugin-functional-android.json'],
    ['Android WebView 魔法大典与导出', 'magic-functional-android.json'],
    ['Android 原聊天界面普通/流式生成', 'generation-ui-android.json'],
    ['APK 原生库 ELF 对齐', 'native-verification.json'],
    ['原目录文件和 Git 状态保护', 'source-verification.json'],
];

export function evaluateEvidence(evidence, identity) {
    if (evidence?.passed === false) return { verified: false, status: '失败' };
    if (evidence?.passed !== true) return { verified: false, status: '缺少明确通过结果' };
    const testedAt = Date.parse(evidence.testedAt);
    if (!Number.isFinite(testedAt) || testedAt > identity.now.getTime()) return { verified: false, status: '时间缺失或无效' };
    if (!/^[a-f0-9]{64}$/i.test(identity.sourceHash || '') || !/^[a-f0-9]{64}$/i.test(identity.runtimeSha256 || '')) return { verified: false, status: '当前构建身份不完整' };
    if (evidence.appVersion !== identity.appVersion || evidence.sourceHash !== identity.sourceHash || evidence.runtimeSha256 !== identity.runtimeSha256) return { verified: false, status: '历史记录或构建身份不匹配' };
    return { verified: true, status: '通过（对应当前源码与运行资源）' };
}

function evaluateRequiredChecks(evidence, requiredChecks) {
    if (!Array.isArray(evidence.checks) || !evidence.checks.length) return '缺少必需检查';
    const ids = new Set();
    for (const check of evidence.checks) {
        if (!check || typeof check.id !== 'string' || !check.id || ids.has(check.id) || typeof check.required !== 'boolean') return '检查标识或 required 字段无效';
        ids.add(check.id);
    }
    const required = evidence.checks.filter(check => check.required);
    if (!required.length || required.some(check => check.passed !== true)) return '必需检查未全部通过';
    if (!Array.isArray(requiredChecks) || requiredChecks.some(id => typeof id !== 'string' || !required.some(check => check.id === id))) return '缺少此次要求的检查';
    return null;
}

export async function writeReport(root = path.resolve(import.meta.dirname, '..'), { evidenceFiles } = {}) {
    const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
    let runtimeSha256 = null;
    try { runtimeSha256 = JSON.parse(await fs.readFile(path.join(root, 'android/app/src/main/assets/runtime.json'), 'utf8')).runtimeSha256; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const now = new Date();
    const identity = { appVersion: version, sourceHash: await getSourceHash(root), runtimeSha256, now };
    const historical = evidenceFiles === undefined;
    if (!historical && !Array.isArray(evidenceFiles)) throw new Error('evidenceFiles must be an explicit array');
    const selected = historical
        ? rows.map(([name, file]) => ({ name, file: 'docs/' + file, requiredChecks: [] }))
        : evidenceFiles.map(entry => typeof entry === 'string' ? { name: path.basename(entry), file: entry, requiredChecks: [] } : { name: entry.name || path.basename(entry.file), file: entry.file, requiredChecks: entry.requiredChecks || [] });
    const checks = [];
    const seen = new Set();
    for (const { name, file, requiredChecks } of selected) {
        let result;
        let testedAt = null;
        try {
            const absolute = path.resolve(root, file);
            const relative = path.relative(path.resolve(root, 'docs'), absolute);
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !file.endsWith('.json') || seen.has(absolute)) throw new Error('Invalid or duplicate evidence path');
            seen.add(absolute);
            const evidence = JSON.parse(await fs.readFile(absolute, 'utf8'));
            testedAt = evidence.testedAt || null;
            result = evaluateEvidence(evidence, identity);
            if (historical) result = { verified: false, status: '历史记录（不参与此次门禁）：' + result.status };
            else if (result.verified) {
                const invalid = evaluateRequiredChecks(evidence, requiredChecks);
                if (invalid) result = { verified: false, status: invalid };
            }
        } catch (error) { result = { verified: false, status: error.code === 'ENOENT' ? '尚未提供记录' : '记录无法解析' }; }
        checks.push({ name, file, requiredChecks, testedAt, ...result });
    }
    const report = { appVersion: version, sourceHash: identity.sourceHash, runtimeSha256, generatedAt: now.toISOString(), historical, passed: !historical && checks.length > 0 && checks.every(check => check.verified), checks };
    const basename = `verification-${version}-${now.toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
    const jsonPath = path.join(root, 'docs', basename + '.json');
    const markdownPath = path.join(root, 'docs', basename + '.md');
    await fs.mkdir(path.dirname(jsonPath), { recursive: true });
    const markdown = `# ${version} 验证证据索引\n\n生成时间：${report.generatedAt}。生成索引不代表重新运行测试。只有显式通过、时间有效且版本、源码和运行资源哈希均匹配的证据标记通过。\n\n源码 SHA-256：${report.sourceHash}\n\n运行资源 SHA-256：${runtimeSha256 || '未提供'}\n\n| 项目 | 状态 | 原测试时间 | 证据 |\n|---|---|---|---|\n`
        + checks.map(check => `| ${check.name} | ${check.status} | ${check.testedAt || '未记录'} | [${check.file}](${path.relative(path.join(root, 'docs'), path.resolve(root, check.file)).replaceAll('\\', '/')}) |`).join('\n')
        + '\n\n历史验收和未解决限制保留在 [TEST-RESULTS.md](TEST-RESULTS.md)，本索引不覆盖或撤销那些限制。\n';
    await fs.writeFile(jsonPath, JSON.stringify(report, null, 2), { flag: 'wx' });
    await fs.writeFile(markdownPath, markdown, { flag: 'wx' });
    return { jsonPath, markdownPath, ...report };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) console.log(JSON.stringify(await writeReport(), null, 2));
