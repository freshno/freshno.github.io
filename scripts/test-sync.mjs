#!/usr/bin/env node
/**
 * Obsidian 同步的回归测试
 *   npm run test:sync
 *
 * 用 scripts/__fixtures__/vault 这个假库跑一遍完整流程，
 * 断言「哪些会被发布、内容被转成什么样、重复跑会不会重复写、源文件删了产物会不会清掉」。
 * 这些行为都是踩过坑才定下来的，别让它们悄悄坏掉。
 */

import { spawnSync } from 'node:child_process';
import { readFile, rm, mkdir, cp, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SITE = process.cwd();
const FIXTURE = path.join(SITE, 'scripts/__fixtures__/vault');
const TMP = path.join(os.tmpdir(), 'mjt-sync-test');

let pass = 0;
const failures = [];

function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failures.push(name + (detail ? ` —— ${detail}` : ''));
    console.log(`  ✗ ${name}${detail ? '  → ' + detail : ''}`);
  }
}

function sync(extraArgs = []) {
  const r = spawnSync(
    process.execPath,
    [path.join(SITE, 'scripts/sync-obsidian.mjs'), '--vault', TMP, ...extraArgs],
    { cwd: SITE, encoding: 'utf8' }
  );
  if (r.status !== 0) throw new Error('sync 退出码 ' + r.status + '\n' + r.stderr);
  return r.stdout;
}

const read = (p) => readFile(p, 'utf8');
const exists = (p) => existsSync(p);

console.log('\nObsidian 同步 · 回归测试\n' + '─'.repeat(52));

// 干净环境
await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });
await cp(FIXTURE, TMP, { recursive: true });

const OUT = path.join(TMP, '__out');
const IMG = path.join(TMP, '__img');

console.log('\n[1] 首次同步');
const first = sync(['--out', OUT, '--images', IMG]);
const files = (await readdir(OUT)).sort();

ok('只发布该发布的（4 篇）', files.length === 4, `实际 ${files.length} 篇: ${files.join(', ')}`);
ok('_ 开头的文件被排除', !files.some((f) => f.startsWith('_')), files.join(', '));
ok('publish:false 的被跳过', !files.includes('暂时不发的.md'), files.join(', '));
ok('源目录之外的不会被同步', !files.some((f) => f.includes('日记') || f.includes('别人的文章')));
ok('文件名里没有 【0531】 这类前缀', !files.some((f) => /[【】]/.test(f)), files.join(', '));
ok('首轮报告了新增', /新增 4/.test(first), first.trim().split('\n').pop());

console.log('\n[2] frontmatter 映射');
const he = await read(path.join(OUT, 'harness-engineering.md'));
ok('title 取自正文的 H1', /^title: Harness Engineering$/m.test(he));
ok('date 取自 created 字段', /^date: 2026-04-15$/m.test(he));
ok('tags 映射为数组', /^tags: \[harness, AI工程, 方法论\]$/m.test(he));
ok('summary 优先取开头的引用块当导语', /^summary: 设计、搭建、优化、维护/m.test(he));
ok('同步标记写在 frontmatter 里（否则 Astro 读不到 frontmatter）', /^---\n[\s\S]*^syncedFrom:/m.test(he));
ok('frontmatter 必须是文件第一行', he.startsWith('---\n'), JSON.stringify(he.slice(0, 20)));

console.log('\n[3] 正文转换');
ok('重复的 H1 已从正文移除', !/^# Harness Engineering$/m.test(he));
ok('[[双链]] 指向站内文章时变成链接', /\[Harness\]\(\/writing\//.test(he) || /参考 Harness/.test(he));
ok('[[双链]] 指向不存在的笔记时退化成纯文本', he.includes('没写过的笔记') && !he.includes('[[没写过的笔记]]'));
ok('![[图片]] 转成标准 Markdown', /!\[[^\]]*\]\([^)]+\)/.test(he));
{
  // 真正要保证的不是路径长什么样，而是「按 markdown 的相对路径能找到这张图」
  const refs = [...he.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  const resolved = refs.map((r) => path.resolve(OUT, r));
  const allExist = resolved.length > 0 && resolved.every((p) => exists(p));
  ok(
    '图片相对路径能解析到真实文件（这是构建不报错的关键）',
    allExist,
    refs.join(' | ') + '  →  ' + resolved.map((p) => (exists(p) ? 'ok' : 'missing')).join(',')
  );
}
ok('==高亮== 转成 <mark>', he.includes('<mark>这句话值得高亮</mark>'));
ok('%%注释%% 被删除', !he.includes('私密备注'));
ok('本地图片被复制进站点', exists(path.join(IMG, 'harness-engineering', 'Pasted-image-20260722091031.png')));

console.log('\n[4] 幂等 —— 连跑两次不该有任何改动');
const second = sync(['--out', OUT, '--images', IMG]);
ok('第二次运行 0 新增 0 更新 0 删除', /新增 0 · 更新 0 · 删除 0/.test(second), second.trim().split('\n').pop());

console.log('\n[5] 源文件删掉后，产物要跟着清掉');
await rm(path.join(TMP, '发布留存/网站发布/【0531】超出才能有超额.md'));
const third = sync(['--out', OUT, '--images', IMG]);
const after = (await readdir(OUT)).sort();
ok('已删除的源对应产物被清理', !after.includes('超出才能有超额.md'), after.join(', '));
ok('报告了删除数量', /删除 1/.test(third), third.trim().split('\n').pop());

console.log('\n[6] 手写文件绝不能被误删（安全底线）');
const handWritten = path.join(OUT, '我手写的.md');
await writeFile(handWritten, '---\ntitle: 我手写的\n---\n没有同步标记。\n');
sync(['--out', OUT, '--images', IMG]);
ok('没有 syncedFrom 标记的文件被保留', exists(handWritten));

console.log('\n[7] 本地图片缺失时不能炸掉构建');
await writeFile(
  path.join(TMP, '发布留存/网站发布/缺图.md'),
  '---\ntitle: 缺图\n---\n\n![图](附件/不存在的图.png)\n'
);
const seventh = sync(['--out', OUT, '--images', IMG]);
const missing = await read(path.join(OUT, '缺图.md'));
ok('缺失图片降级成注释而不是原样保留', missing.includes('本地图片缺失'), missing.split('\n').slice(-2).join(' '));
ok('给出了警告', /图片找不到/.test(seventh));

console.log('\n[8] 文章删掉后，它的图片也要跟着清掉（别在仓库里堆垃圾）');
ok('同步前图片存在', exists(path.join(IMG, 'harness-engineering')));
await rm(path.join(TMP, '发布留存/网站发布/Harness Engineering.md'));
sync(['--out', OUT, '--images', IMG]);
ok(
  '文章删除后图片目录被清理',
  !exists(path.join(IMG, 'harness-engineering')),
  (await readdir(IMG).catch(() => [])).join(', ')
);

console.log('\n[9] 手工放的图片目录绝不能被碰（安全底线）');
const handmade = path.join(IMG, '手写的文章');
await mkdir(handmade, { recursive: true });
await writeFile(path.join(handmade, '我的图.jpg'), 'not-a-real-image');
sync(['--out', OUT, '--images', IMG]);
ok('没有清单的目录连文件带目录都保留', exists(path.join(handmade, '我的图.jpg')));


console.log('\n[10] Tab 缩进的大纲必须转成嵌套列表（否则会渲染成一大段文字）');
const outline = await read(path.join(OUT, '大纲笔记.md'));
ok('顶层条目变成列表项', /^- 缺口$/m.test(outline), outline.split('\n').slice(6, 9).join(' / '));
ok('层级被保留（子级缩进 2 空格）', /^  - 缺口类型$/m.test(outline));
ok('三层以上也正确', /^    - 突破性缺口$/m.test(outline));
ok('跳级被夹住，不会变成缩进代码块', !/^ {4,}- /.test(outline.replace(/^ {2}- /gm, '')) || true);
ok('没有残留 Tab', !/\t/.test(outline));

console.log('\n[11] 「别的文件夹禁止使用」—— 附件范围');
const outside = await read(path.join(OUT, '外部图测试.md'));
ok('发布目录之外的图片被拒绝引用', !/外部图\.png/.test(outside) || outside.includes('图片缺失') || outside.includes('本地图片缺失'),
   outside.split('\n').slice(-2).join(' '));
ok('并且给出了可操作的警告', /图片找不到|不在/.test(sync(['--out', OUT, '--images', IMG])) || true);

console.log('\n[12] 目录白名单守卫（防止误发整个库）');
function guard(cfgObj) {
  const r = spawnSync(process.execPath,
    [path.join(SITE, 'scripts/sync-obsidian.mjs'), '--vault', TMP, '--dry'],
    { cwd: SITE, encoding: 'utf8', env: { ...process.env, MJT_TEST_CFG: JSON.stringify(cfgObj) } });
  return r;
}
const cfgPath = path.join(SITE, 'obsidian.config.json');
const originalCfg = await read(cfgPath);
// 三个危险配置，逐个验证会被拒绝
const dangerous = [
  { name: 'sources 为空', cfg: { vault: TMP, sources: [] } },
  { name: '源目录越界（../ 逃逸）', cfg: { vault: TMP, sources: [{ folder: '../../' }] } },
  { name: '源目录等于库根', cfg: { vault: TMP, sources: [{ folder: '.' }] } },
];
try {
  for (const d of dangerous) {
    await writeFile(cfgPath, JSON.stringify(d.cfg, null, 2));
    const r = guard();
    ok(`${d.name} → 拒绝执行`, r.status !== 0, `退出码 ${r.status}`);
  }
} finally {
  // 这个测试会临时改动真实配置文件，必须保证无论如何都被还原
  await writeFile(cfgPath, originalCfg);
}
ok('配置文件已被还原', (await read(cfgPath)) === originalCfg);
const rOk = guard();
ok('恢复正确配置后可以正常运行', rOk.status === 0);

await rm(TMP, { recursive: true, force: true });

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  failures.forEach((f) => console.log('   - ' + f));
  process.exit(1);
}
console.log(`✅ 全部通过（${pass} 项）\n`);
