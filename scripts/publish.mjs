#!/usr/bin/env node
/**
 * 一条命令发布：同步 Obsidian → 构建 → 推送到远端
 * =====================================================================
 *   npm run publish            同步 + 构建（不推送）
 *   npm run publish -- --push  同步 + 构建 + git commit + push（真正上线）
 *
 * 推送到远端之后，Cloudflare Pages / Vercel 会自动构建部署。
 * 不是 git 仓库时会自动跳过推送那一步，只做同步和构建。
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const SITE = process.cwd();
const push = process.argv.includes('--push');

function sh(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: SITE, stdio: 'inherit', shell: false, ...opts });
}

function step(n, total, title) {
  console.log(`\n${'─'.repeat(58)}`);
  console.log(`  ${n}/${total}  ${title}`);
  console.log('─'.repeat(58));
}

function isGitRepo() {
  const r = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: SITE,
    encoding: 'utf8',
  });
  return r.status === 0 && String(r.stdout).trim() === 'true';
}

function hasRemote() {
  const r = spawnSync('git', ['remote'], { cwd: SITE, encoding: 'utf8' });
  return r.status === 0 && String(r.stdout).trim().length > 0;
}

function changed() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: SITE, encoding: 'utf8' });
  return r.status === 0 && String(r.stdout).trim().length > 0;
}

/* ---------------------------------------------------------------- 1. 同步 */

step(1, 3, '从 Obsidian 同步');
let r = sh(process.execPath, [path.join(SITE, 'scripts/sync-obsidian.mjs')]);
if (r.status !== 0) {
  console.error('\n❌ 同步失败，已中止（站点的旧内容没有被破坏）。');
  process.exit(1);
}

/* ---------------------------------------------------------------- 2. 构建 */

step(2, 3, '构建站点');
const astroBin = path.join(SITE, 'node_modules/astro/bin/astro.mjs');
if (!existsSync(astroBin)) {
  console.error('找不到 Astro，请先 npm install。');
  process.exit(1);
}
r = sh(process.execPath, [astroBin, 'build']);
if (r.status !== 0) {
  console.error('\n❌ 构建失败，已中止 —— 没有推送任何东西，线上还是上一版。');
  process.exit(1);
}

/* ---------------------------------------------------------------- 3. 推送 */

step(3, 3, '推送到远端');
if (!push) {
  console.log('  （未加 --push，跳过）\n');
  console.log('  本地已构建好，想上线就执行：');
  console.log('    npm run publish -- --push\n');
  process.exit(0);
}

if (!isGitRepo()) {
  console.log('  当前目录还不是 git 仓库，跳过推送。\n');
  console.log('  想上线，先初始化：');
  console.log('    git init && git add -A && git commit -m "init"');
  console.log('    git remote add origin <你的仓库地址>\n');
  process.exit(0);
}

if (!changed()) {
  console.log('  没有内容变化，无需提交。\n');
  process.exit(0);
}

sh('git', ['add', '-A']);
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
r = sh('git', ['commit', '-m', `post: ${stamp}`]);
if (r.status !== 0) {
  console.error('\n❌ 提交失败。');
  process.exit(1);
}

if (!hasRemote()) {
  console.log('\n  已提交，但没配置远端，跳过推送。');
  console.log('    git remote add origin <你的仓库地址> && git push -u origin main\n');
  process.exit(0);
}

r = sh('git', ['push']);
if (r.status !== 0) {
  console.error('\n❌ 推送失败（本地提交还在，重试 `git push` 即可）。');
  process.exit(1);
}

console.log('\n✅ 已推送。托管平台会自动构建部署，一两分钟后线上就是新的。\n');
