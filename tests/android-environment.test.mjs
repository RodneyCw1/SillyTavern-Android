import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const project = path.resolve(import.meta.dirname, '..');
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'st-jdk-selection-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const candidates = {};
    for (const [name, tools] of Object.entries({ incomplete: ['java', 'javac'], old: ['java', 'javac', 'jlink'], current: ['java', 'javac', 'jlink'] })) {
        const home = path.join(root, name);
        candidates[name] = home;
        await fs.mkdir(path.join(home, 'bin'), { recursive: true });
        for (const tool of tools) await fs.writeFile(path.join(home, 'bin', tool + '.exe'), 'fixture marker; never executed');
    }
    await fs.writeFile(path.join(root, 'select.ps1'), `param([string]$Source,[string]$InputFile)
$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Source,[ref]$tokens,[ref]$errors)
$definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Find-AndroidJdk21'},$true)
if(-not $definition){throw 'JDK selection helper is missing'}
. ([scriptblock]::Create($definition.Extent.Text))
$inputData=Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json -AsHashtable
$versions=$inputData.versions
$readVersion={param($Candidate) $versions[$Candidate]}
Find-AndroidJdk21 -Candidates $inputData.candidates -ReadVersion $readVersion
`);
    return { root, candidates };
}
async function select(context, candidates, versions) {
    const input = path.join(context.root, 'input.json');
    await fs.writeFile(input, JSON.stringify({ candidates, versions }));
    return spawnSync('pwsh', ['-NoProfile', '-File', path.join(context.root, 'select.ps1'), '-Source', path.join(project, 'scripts/environment.ps1'), '-InputFile', input], { encoding: 'utf8', timeout: 15000 });
}

test('Android environment skips a JBR missing jlink and selects a complete JDK 21', { skip: process.platform !== 'win32' }, async t => {
    const context = await fixture(t);
    const { incomplete, current } = context.candidates;
    const result = await select(context, [incomplete, current], { [incomplete]: 'javac 21.0.5', [current]: 'javac 21.0.12.1' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), current);
});

test('Android environment skips a complete JDK with the wrong compiler version', { skip: process.platform !== 'win32' }, async t => {
    const context = await fixture(t);
    const { old, current } = context.candidates;
    const result = await select(context, [old, current], { [old]: 'javac 17.0.1', [current]: 'javac 21.0.12.1' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), current);
});

test('Android environment refuses candidates with no complete JDK 21', { skip: process.platform !== 'win32' }, async t => {
    const context = await fixture(t);
    const { incomplete, old } = context.candidates;
    const result = await select(context, [incomplete, old], { [incomplete]: 'javac 21.0.5', [old]: 'javac 17.0.1' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /complete JDK 21.*jlink/i);
});
