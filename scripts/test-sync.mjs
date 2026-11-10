#!/usr/bin/env node
/**
 * Obsidian 同步的回归测试
 *   npm run test:sync
 *
 * 用 scripts/__fixtures__/vault 这个假库跑一遍完整流程，断言：
 *   - 四种内容类型（文章/项目/日常/关于）各自被正确识别和转换
 *   - 目录白名单、手写文件保护、幂等、清理等安全边界
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
const list = async (p) => (await readdir(p).catch(() => [])).sort();

console.log('\nObsidian 同步 · 回归测试\n' + '─'.repeat(52));

// 干净环境
await rm(TMP, { recursive: true, force: true });
await mkdir(TMP, { recursive: true });
await cp(FIXTURE, TMP, { recursive: true });

const OUT = path.join(TMP, '__out');
const IMG = path.join(TMP, '__img');

console.log('\n[1] 四种内容类型都被识别');
const first = sync(['--out', OUT, '--images', IMG]);
for (const [type, label, n] of [
  ['writing', '文章', 4],
  ['work', '项目', 1],
  ['notes', '日常', 1],
  ['page', '关于', 1],
]) {
  const files = await list(path.join(OUT, type));
  ok(`${label}：产出 ${n} 个`, files.length === n, `实际 ${files.length}: ${files.join(', ')}`);
}

console.log('\n[2] 文章（writing）');
const wdir = path.join(OUT, 'writing');
const wfiles = await list(wdir);
ok('_ 开头的被排除', !wfiles.some((f) => f.startsWith('_')), wfiles.join(', '));
ok('publish:false 的被跳过', !wfiles.includes('暂时不发的.md'), wfiles.join(', '));
ok('文件名里的【0531】被剥掉', !wfiles.some((f) => /[【】]/.test(f)), wfiles.join(', '));
ok('发布目录之外的不会混进来', !wfiles.some((f) => f.includes('别人的文章')));

const he = await read(path.join(wdir, 'harness-engineering.md'));
ok('标题取自正文 H1', /^title: Harness Engineering$/m.test(he));
ok('日期取自 created 字段', /^date: 2026-04-15$/m.test(he));
ok('tags 是数组', /^tags: \[harness, AI工程, 方法论\]$/m.test(he));
ok('摘要优先用开头引用块', /^summary: 设计、搭建、优化、维护/m.test(he));
ok('frontmatter 在第一行（否则 Astro 读不到）', he.startsWith('---\n'), JSON.stringify(he.slice(0, 12)));
ok('同步标记在 frontmatter 里', /^---\n[\s\S]*^syncedFrom:/m.test(he));
ok('重复的 H1 从正文移除', !/^# Harness Engineering$/m.test(he));
ok('==高亮== 转成 <mark>', he.includes('<mark>这句话值得高亮</mark>'));
ok('%%注释%% 被删除', !he.includes('私密备注'));
ok('[[双链]] 指向不存在笔记时退化成文本', he.includes('没写过的笔记') && !he.includes('[[没写过的笔记]]'));

console.log('\n[3] 大纲型笔记（Tab 缩进 → 嵌套列表）');
const outline = await read(path.join(wdir, '大纲笔记.md'));
ok('顶层变成列表项', /^- 缺口$/m.test(outline));
ok('层级保留', /^  - 缺口类型$/m.test(outline));
ok('三层以上正确', /^    - 突破性缺口$/m.test(outline));
ok(
  '同级兄弟不会越缩越深',
  /^        - 光头阴线/m.test(outline) && /^        - 长下影线的阳线/m.test(outline),
  outline.split('\n').filter((l) => l.includes('光头') || l.includes('长下影')).join(' | ')
);
ok('没有残留 Tab', !/\t/.test(outline));

console.log('\n[4] 图片搬运');
{
  const refs = [...he.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  const resolved = refs.map((r) => path.resolve(wdir, r));
  ok(
    '文章图片路径能解析到真实文件',
    resolved.length > 0 && resolved.every((p) => exists(p)),
    refs.join(' | ')
  );
  ok('本地图片被复制进 writing 图片目录', exists(path.join(IMG, 'writing', 'harness-engineering')));
}
const outside = await read(path.join(wdir, '外部图测试.md'));
ok(
  '发布目录之外的图片被拒绝',
  outside.includes('本地图片缺失') || outside.includes('图片缺失'),
  outside.split('\n').slice(-2).join(' ')
);

console.log('\n[5] 项目（work）');
const wo = await read(path.join(OUT, 'work', '慢读.md'));
ok('year 保留原样', /^year: 2025$/m.test(wo));
ok('status 是合法值', /^status: 在做$/m.test(wo));
ok('stack 转成数组', /^stack: \[TypeScript, SQLite, Tauri\]$/m.test(wo));
ok('link 保留', /^link: https:\/\/example\.com\/slow-read$/m.test(wo));
ok('order 是数字', /^order: 3$/m.test(wo));
ok('摘要来自正文首段', /^summary: 一个只给自己用的读书笔记工具/m.test(wo));

console.log('\n[6] 日常（notes）');
const nd = await read(path.join(OUT, 'notes', '2026-11-08-窗边的桌子.md'));
ok('日期取自文件名', /^date: 2026-11-08$/m.test(nd), (nd.match(/^date: .*/m) || [''])[0]);
ok('图片写进 frontmatter（不在正文里）', /^images:/m.test(nd) && !/!\[/.test(nd), nd.slice(0, 260));
ok('图片条目有 src 和 caption', /- src: /.test(nd) && /caption: /.test(nd));
ok('正文只剩文字', nd.includes('今天只做一件事'));
ok(
  '图片平铺进日常图片目录（不分子文件夹）',
  exists(IMG) && (await list(IMG)).some((f) => f.includes('贴图')),
  (await list(IMG)).join(', ')
);

console.log('\n[7] 关于（page）');
const pg = exists(path.join(OUT, 'page', 'about.md'))
  ? await read(path.join(OUT, 'page', 'about.md'))
  : '';
ok('输出成固定的 about.md', exists(path.join(OUT, 'page', 'about.md')));
ok('doing 保留', /^doing: 做产品、写代码$/m.test(pg));
ok('located 保留', /^located: 杭州$/m.test(pg));
ok('正文是 markdown 段落', pg.includes('你好，欢迎来到'));

console.log('\n[7.5] 日期稳定性 —— 改了老文章，发布日期不该变');
{
  const { utimes } = await import('node:fs/promises');
  const target = path.join(OUT, 'writing', '大纲笔记.md');
  const before = (await read(target)).match(/^date: (\d{4}-\d{2}-\d{2})$/m)?.[1];
  // 模拟「一年后又编辑了一次」：只改文件的修改时间，内容不动
  const future = new Date('2027-06-01T10:00:00');
  await utimes(path.join(TMP, '发布留存/网站发布/文章/大纲笔记.md'), future, future);
  await utimes(path.join(TMP, '发布留存/网站发布/日常/2026-11-08-窗边的桌子.md'), future, future);
  sync(['--out', OUT, '--images', IMG]);
  const after = (await read(target)).match(/^date: (\d{4}-\d{2}-\d{2})$/m)?.[1];
  ok('没写 date 的文章，重新编辑后仍保留首次发布日期', before === after, `${before} → ${after}`);
  ok('日期不是今天（2027-06-01 没被采用）', after !== '2027-06-01', after);
}

console.log('\n[8] 幂等 —— 连跑两次不该有任何改动');
const second = sync(['--out', OUT, '--images', IMG]);
ok('第二次 0 新增 0 更新 0 删除', /新增 0 · 更新 0 · 删除 0/.test(second), second.trim().split('\n').pop());

console.log('\n[9] 源文件删了，产物要跟着清掉（分类型）');
await rm(path.join(TMP, '发布留存/网站发布/项目/慢读.md'));
const third = sync(['--out', OUT, '--images', IMG]);
ok(
  '项目的产物被删除',
  !exists(path.join(OUT, 'work', '慢读.md')),
  (await list(path.join(OUT, 'work'))).join(', ') || '(空)'
);
ok('文章不受影响', exists(path.join(OUT, 'writing', 'harness-engineering.md')));
ok('报告了删除', /删除 1/.test(third), third.trim().split('\n').pop());

console.log('\n[10] 手写文件绝不能被误删');
const handWritten = path.join(OUT, 'writing', '我手写的.md');
await writeFile(
  handWritten,
  '---\ntitle: 我手写的\ndate: 2026-01-01\ntags: []\nsummary: x\n---\n没有同步标记。\n'
);
sync(['--out', OUT, '--images', IMG]);
ok('没有 syncedFrom 标记的文件保留', exists(handWritten));

console.log('\n[11] 目录白名单守卫（防止误发整个库）');
const cfgPath = path.join(SITE, 'obsidian.config.json');
const originalCfg = await read(cfgPath);
function guard() {
  return spawnSync(
    process.execPath,
    [path.join(SITE, 'scripts/sync-obsidian.mjs'), '--vault', TMP, '--dry'],
    { cwd: SITE, encoding: 'utf8' }
  );
}
const dangerous = [
  { name: 'root 为空', cfg: { vault: TMP, root: '' } },
  { name: 'root 越界（../../）', cfg: { vault: TMP, root: '../../' } },
  { name: 'root 等于库根', cfg: { vault: TMP, root: '.' } },
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
ok('恢复正确配置后能正常运行', guard().status === 0);

await rm(TMP, { recursive: true, force: true });

console.log('\n' + '─'.repeat(52));
if (failures.length) {
  console.log(`❌ ${failures.length} 项失败 / 共 ${pass + failures.length} 项`);
  failures.forEach((f) => console.log('   - ' + f));
  process.exit(1);
}
console.log(`✅ 全部通过（${pass} 项）\n`);
