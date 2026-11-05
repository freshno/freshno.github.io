#!/usr/bin/env node
/**
 * Obsidian → 站点 同步
 * =====================================================================
 * 你在 Obsidian 的一个目录里写，这条命令把它转成 Astro 能读的文章。
 *
 *   npm run sync              同步一次
 *   npm run sync -- --dry     只看会改什么，不写文件
 *   npm run sync -- --watch   挂着监听，Obsidian 里一存就同步
 *
 * 它做的转换（都是 Obsidian 特有、Astro 不认识的东西）：
 *   [[双链]]              → 站内链接（目标也在同步范围里）或纯文本
 *   ![[图片.png|697]]     → 复制图片进站点 + 生成标准 Markdown 图片
 *   > [!note] 标注        → 引用块
 *   %%注释%%              → 删掉
 *   ==高亮==              → <mark>
 *   frontmatter 的个性字段 → 映射成站点需要的 title/date/tags/summary
 *   正文开头的 # 一级标题  → 提升为文章标题，正文里不再重复
 *
 * 安全设计：只读「发布目录」，只写站点内容目录。
 * 站点目录里**没有同步标记**的文件（你自己手写的）绝不会被删。
 */

import { readFile, writeFile, mkdir, readdir, rm, copyFile, stat } from 'node:fs/promises';
import { existsSync, watch as fsWatch } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { load as parseYaml } from 'js-yaml';

const SITE = process.cwd();
// 同步标记写在 frontmatter 里。Zod 会忽略未知字段，所以它不会进到页面数据里，
// 但同步脚本能靠它认出「哪些文件是我生成的」，从而安全地清理旧产物。
const MARK = 'syncedFrom';
const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.bmp']);
// 图片目录里的清单文件。只有带这个清单的目录才归同步脚本管，
// 手工放进去的图片目录（比如 src/assets/images/writing/white-space/）绝不会被碰。
const IMG_MANIFEST = '.obsidian-sync.json';

/* ---------------------------------------------------------------- 工具 */

const expand = (p) => (p?.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const rel = (p) => path.relative(SITE, p);
const log = (...a) => console.log(...a);
const warn = (msg) => console.log('  ⚠️  ' + msg);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (k === 'dry' || k === 'watch' || k === 'json' || k === 'verbose') out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

/** 文件名 → URL slug。中文原样保留，去掉 【】* 等标点 */
function slugify(name) {
  return (
    name
      .normalize('NFKC')
      .replace(/^【\s*\d+\s*】\s*/, '') // 【0531】标题 → 标题
      .replace(/^\[[^\]]*\]\s*/, '')
      .replace(/[*_`~<>:"/\\|?]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 80) || 'untitled'
  );
}

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date && !Number.isNaN(v.valueOf())) return v;
  const d = new Date(String(v).trim().replace(/^["']|["']$/g, ''));
  return Number.isNaN(d.valueOf()) ? null : d;
}

/** 只对必要的情况加引号，产出好读的 frontmatter */
function yamlScalar(s) {
  const str = String(s);
  if (str === '') return '""';
  if (/^[\p{L}\p{N}][\p{L}\p{N}\s,.。，、！？!?;；:：()（）\-—_/]*$/u.test(str) && !/:\s|\s#/.test(str))
    return str;
  return JSON.stringify(str);
}

/** frontmatter + 正文 */
function splitFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, '');
  if (!text.startsWith('---')) return { data: {}, body: text };
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  let data = {};
  try {
    data = parseYaml(m[1]) ?? {};
  } catch {
    data = {};
  }
  if (typeof data !== 'object' || Array.isArray(data)) data = {};
  return { data, body: text.slice(m[0].length) };
}

/* ------------------------------------------------- 扫描库 / 建立索引 */

async function walkMd(dir, out = []) {
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walkMd(full, out);
    else if (e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * 文件索引：Obsidian 的 ![[名字]] 是按文件名解析的，与路径无关。
 * roots 限定扫描范围 —— 只会扫「允许的目录」，别处的图片一律不引用。
 */
async function indexVaultFiles(roots, out = new Map()) {
  const dirs = Array.isArray(roots) ? roots : [roots];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    let entries = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await indexVaultFiles(full, out);
      else if (!out.has(e.name)) out.set(e.name, full);
    }
  }
  return out;
}

/* ------------------------------------------------------------ 正文转换 */

/**
 * 判断是不是「大纲型」笔记。
 * 这个库里大量笔记是 Tab 缩进的纯大纲（没有列表标记、没有空行分段），
 * Markdown 会把这种内容合并成一大段文字 —— 必须先识别出来再转换。
 */
function looksLikeOutline(body) {
  const lines = body.split('\n').filter((l) => l.trim());
  if (lines.length < 8) return false;
  const indented = lines.filter((l) => /^(\t| {2,}\S)/.test(l)).length;
  const listed = lines.filter((l) => /^\s*([-*+]|\d+\.)\s/.test(l)).length;
  return indented / lines.length >= 0.35 && listed / lines.length < 0.1;
}

/** Tab / 空格缩进的大纲 → 嵌套 Markdown 列表，保留原有层级 */
function outlineToLists(body) {
  const raw = body.split('\n');
  const usesTabs = raw.some((l) => /^\t/.test(l));

  const levelOf = (line) => {
    const lead = (line.match(/^[ \t]*/) || [''])[0];
    if (usesTabs) {
      const tabs = (lead.match(/\t/g) || []).length;
      const spaces = lead.replace(/\t/g, '').length;
      return tabs + Math.floor(spaces / 2);
    }
    return Math.floor(lead.length / 2);
  };

  const out = [];
  let inFence = false;
  let prevOut = -1;
  // 原文缩进宽度 → 输出层级。必须记住映射：
  // 否则「5 个 tab」这种跳级行被夹到 4 之后，下一行同样 5 个 tab 会被夹到 5，
  // 同级兄弟就一行比一行深，越缩越歪。
  const levelMap = new Map();

  const outLevelOf = (orig) => {
    if (levelMap.has(orig)) return levelMap.get(orig);
    const lvl = prevOut < 0 ? Math.max(0, Math.min(orig, 0)) : Math.min(orig, prevOut + 1);
    levelMap.set(orig, lvl);
    return lvl;
  };

  for (const line of raw) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (!line.trim()) {
      out.push('');
      continue;
    }
    if (/^\s*#{1,6}\s/.test(line)) {
      out.push(line.trim());
      prevOut = -1;
      continue;
    }
    const lvl = outLevelOf(levelOf(line));
    out.push('  '.repeat(Math.max(0, lvl)) + '- ' + line.trim());
    prevOut = lvl;
  }
  return out.join('\n');
}

function stripComments(body) {
  return body.replace(/%%[\s\S]*?%%/g, '');
}

function convertCallouts(body) {
  // > [!note] 标题  →  > **标题**
  return body.replace(
    /^>\s*\[!([a-zA-Z]+)\][+-]?\s*(.*)$/gm,
    (_, _type, title) => `> **${title.trim() || '提示'}**`
  );
}

function convertHighlights(body) {
  return body.replace(/==([^=\n]+)==/g, '<mark>$1</mark>');
}

/** 收集正文里的 #行内标签 */
function extractInlineTags(body) {
  const tags = [];
  const stripped = body.replace(/(?<![\w#(/[])&?#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu, (m, t) => {
    tags.push(t);
    return '';
  });
  return { body: stripped, tags };
}

/** [[双链]] → 站内链接或纯文本 */
function convertWikilinks(body, targetIndex) {
  return body.replace(/\[\[([^\]]+)\]\]/g, (_m, inner) => {
    const [rawTarget, alias] = inner.split('|').map((s) => s?.trim());
    const [target, anchor] = rawTarget.split(/[#^]/).map((s) => s?.trim());
    const hit = targetIndex.get(target || rawTarget);
    const label = alias || (anchor ? `${target} › ${anchor}` : target);
    return hit ? `[${label}](/writing/${hit.slug}/)` : label;
  });
}

/** 把一个图片文件搬进站点，返回可以从文章引用它的相对路径 */
async function importImage(nameOrPath, ctx) {
  const clean = decodeURIComponent(String(nameOrPath).split('|')[0].trim());
  const src = ctx.vaultFiles.get(path.basename(clean));
  if (!src) {
    ctx.warnings.push(`图片找不到：「${clean}」不在库里，已跳过（该图不会出现在网站上）`);
    return null;
  }
  const safeName = path.basename(src).replace(/[^\p{L}\p{N}._-]+/gu, '-');
  const destDir = path.join(ctx.imageDir, ctx.slug);
  const dest = path.join(destDir, safeName);
  if (!ctx.dry) {
    await mkdir(destDir, { recursive: true });
    await copyFile(src, dest);
  }
  ctx.assets.push(rel(dest));
  // 注意：markdown 的相对路径是相对「文件所在目录」解析的，
  // 基准要用 outDir（目录），不能用 outDir/slug.md（会被多算一层）。
  return path.relative(ctx.outDir, dest).split(path.sep).join('/');
}

/** ![[图片.png|697]] → 复制图片 + 标准 Markdown */
async function convertEmbeds(body, ctx) {
  const found = [...body.matchAll(/!\[\[([^\]]+)\]\]/g)];
  if (!found.length) return body;

  let out = body;
  for (const [whole, inner] of found) {
    const name = inner.split('|')[0].trim();
    const ext = path.extname(name).toLowerCase();

    if (!IMG_EXT.has(ext)) {
      // 嵌入别的笔记（transclusion）：转成链接，不展开
      const hit = ctx.targetIndex.get(name.replace(/\.md$/, ''));
      out = out.replace(whole, hit ? `[${name}](/writing/${hit.slug}/)` : `**${name}**`);
      continue;
    }

    const relPath = await importImage(name, ctx);
    out = out.replace(
      whole,
      relPath ? `![${path.basename(name, ext)}](${relPath})` : `<!-- 图片缺失: ${name} -->`
    );
  }
  return out;
}

/**
 * 标准 Markdown 图片指向库里的本地文件时，也搬进站点。
 * 不处理的话 Astro 会因为找不到这个相对路径而**构建失败**——这是最容易踩的坑。
 * 远程图片（http/https）原样放过。
 */
async function convertLocalMdImages(body, ctx) {
  const found = [...body.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)];
  if (!found.length) return body;

  let out = body;
  for (const [whole, alt, href] of found) {
    if (/^(https?:)?\/\//i.test(href) || href.startsWith('data:')) continue;

    const relPath = await importImage(href, ctx);
    out = out.replace(
      whole,
      relPath
        ? `![${alt}](${relPath})`
        : `<!-- 本地图片缺失，已跳过: ${href} -->`
    );
  }
  return out;
}

/** 丢掉重复的标题、压掉多余空行 */
function tidyBody(body, title) {
  let b = body;
  const h1 = b.match(/^\s*#\s+(.+?)\s*$/m);
  if (h1 && h1[1].replace(/\s/g, '') === String(title).replace(/\s/g, '')) {
    b = b.replace(h1[0], '');
  }
  return b.replace(/^\s*\n/, '').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

/* -------------------------------------------------------------- 摘要 */

function makeSummary(data, body) {
  for (const key of ['summary', 'description', 'abstract', 'excerpt']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return clip(clean(v.trim()));
  }

  const lines = body.split('\n').map((l) => l.trim());

  // 1) 开头的引用块 —— Obsidian 里通常就是这篇文章的导语
  const quote = [];
  for (const l of lines) {
    if (l.startsWith('>')) quote.push(l.replace(/^>\s?/, ''));
    else if (quote.length) break;
    else if (l && !l.startsWith('#')) break;
  }
  if (quote.length) {
    const t = clean(quote.join(' ').replace(/\*\*/g, '').replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1'));
    if (t.length >= 12) return clip(t);
  }

  // 2) 第一段普通段落。以「：」结尾的是列表引导句，不适合当摘要，先跳过
  const paras = [];
  for (const line of lines) {
    if (!line) continue;
    if (/^(#|>|\||```|~~~|!\[|<)/.test(line)) continue;
    if (/^([-*+]|\d+\.)\s/.test(line)) continue;
    const stripped = line
      .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~=]/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    if (stripped.length >= 16) paras.push(stripped);
    if (paras.length >= 3) break;
  }
  const best = paras.find((p) => !/[：:]$/.test(p)) || paras[0];
  if (best) return clip(best);

  // 大纲型笔记没有普通段落：用前几个顶层条目拼一个预览，比重复标题有用
  const tops = [];
  for (const line of lines) {
    const m = line.match(/^-\s+(.+)$/);
    if (m && !line.startsWith('  ')) {
      const t = m[1].replace(/[*_`]/g, '').trim();
      if (t && !tops.includes(t)) tops.push(t);
    }
    if (tops.length >= 4) break;
  }
  return tops.length >= 2 ? clip(tops.join(' · ')) : '';
}

const clean = (s) => s.replace(/\s+/g, ' ').trim();
const clip = (s, n = 110) => (s.length > n ? s.slice(0, n).replace(/[,，、;；]\s*$/, '') + '…' : s);

/* -------------------------------------------------- 单篇：读 → 转 */

async function convertNote(file, ctx) {
  const raw = await readFile(file, 'utf8');
  const { data, body: rawBody } = splitFrontmatter(raw);

  // 排除：显式不发布
  if (data.publish === false || data.draft === 'skip' || data.unlisted === 'skip') {
    return { skip: '标记为不发布' };
  }

  const baseName = path.basename(file, '.md');
  const h1 = rawBody.match(/^\s*#\s+(.+?)\s*$/m);
  const title =
    (typeof data.title === 'string' && data.title.trim()) ||
    (h1 ? h1[1].trim() : '') ||
    baseName.replace(/^【\s*\d+\s*】\s*/, '').replace(/[*_`]/g, '').trim();

  const slug = slugify(
    (typeof data.slug === 'string' && data.slug) || title || baseName
  );

  let st;
  try {
    st = await stat(file);
  } catch {
    st = { mtime: new Date() };
  }
  const date =
    toDate(data.date) || toDate(data.created) || toDate(data.updated) || st.mtime;

  // 标签
  const rawTags = []
    .concat(data.tags ?? data.tag ?? [])
    .flatMap((t) => (Array.isArray(t) ? t : [t]))
    .filter((t) => typeof t === 'string')
    .map((t) => t.replace(/^#/, '').trim())
    .filter(Boolean);

  // 正文
  // 顺序要紧：
  //   1) 先判断大纲并转成嵌套列表 —— 否则整篇会被 Markdown 合并成一大段文字
  //   2) 再处理标准 Markdown 图片，最后处理 ![[嵌入]]
  //      反过来的话，嵌入转换产出的 ![](../../assets/...) 会被再当成"本地图片"处理一遍
  let body = stripComments(rawBody);
  if (ctx.outlineToLists !== false && looksLikeOutline(body)) {
    body = outlineToLists(body);
    ctx.notes.push('大纲 → 嵌套列表');
  }
  body = convertCallouts(body);
  body = convertHighlights(body);
  body = await convertLocalMdImages(body, { ...ctx, slug });
  body = await convertEmbeds(body, { ...ctx, slug });

  let inlineTags = [];
  if (ctx.extractInlineTags) {
    const r = extractInlineTags(body);
    body = r.body;
    inlineTags = r.tags;
  }
  body = convertWikilinks(body, ctx.targetIndex);
  body = tidyBody(body, title);

  const tags = [...new Set([...ctx.sourceTags, ...inlineTags, ...rawTags])];
  const summary = makeSummary(data, body);

  return {
    slug,
    // 记成「相对库根」的路径：可读、可移植，不会把本机目录结构写进仓库
    source: path.relative(ctx.vault, file).split(path.sep).join('/'),
    title,
    date,
    tags,
    summary,
    draft: data.draft === true,
    body,
    warnings: [],
  };
}

function renderNote(n) {
  const fm = [
    '---',
    `title: ${yamlScalar(n.title)}`,
    `date: ${ymd(n.date)}`,
    `tags: [${n.tags.map(yamlScalar).join(', ')}]`,
    `summary: ${yamlScalar(n.summary || n.title)}`,
    ...(n.draft ? ['draft: true'] : []),
    `${MARK}: ${yamlScalar(n.source)}`,
    '---',
    '',
  ].join('\n');
  return fm + n.body;
}

/** 判断一个产物文件是不是同步脚本生成的（手写文件绝不动） */
function isSynced(text) {
  const head = text.slice(0, 600);
  const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return !!m && new RegExp(`^${MARK}:`, 'm').test(m[1]);
}

/* ---------------------------------------------------------- 主流程 */

async function loadConfig(args) {
  const cfgPath = path.join(SITE, 'obsidian.config.json');
  let cfg = {};
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    } catch (e) {
      console.error('obsidian.config.json 解析失败：', e.message);
      process.exit(1);
    }
  }
  const vault = expand(args.vault || cfg.vault || '');
  if (!vault || !existsSync(vault)) {
    console.error(`\n找不到 Obsidian 库：${vault || '(未配置)'}`);
    console.error('请在 site/obsidian.config.json 里填 vault，或用 --vault 指定。\n');
    process.exit(1);
  }
  const vaultReal = path.resolve(vault);
  let sources = cfg.sources ?? [];
  if (args.folder) sources = [{ folder: args.folder }];

  // ── 目录白名单守卫 ────────────────────────────────────────────
  // 「别的文件夹禁止使用」是硬要求，不能靠自觉。这里做三道闸：
  //   1. 必须有明确列出的源目录（空配置直接拒绝，绝不退化成"整个库"）
  //   2. 源目录必须真的在库里面（挡住 .. 和绝对路径逃逸）
  //   3. 源目录不能等于库根目录（那等于全库同步）
  if (!sources.length) {
    console.error('\n❌ obsidian.config.json 里没有配置任何 sources 目录。');
    console.error('   为避免误发整个库，这里直接拒绝执行。请显式列出允许发布的目录。\n');
    process.exit(1);
  }
  for (const s of sources) {
    if (!s?.folder || typeof s.folder !== 'string' || !s.folder.trim()) {
      console.error('\n❌ sources 里有一项没有 folder 字段。\n');
      process.exit(1);
    }
    const abs = path.resolve(vaultReal, s.folder);
    const insideVault = abs === vaultReal || abs.startsWith(vaultReal + path.sep);
    if (!insideVault) {
      console.error(`\n❌ 源目录越界：${s.folder}`);
      console.error(`   解析后是 ${abs}，不在库 ${vaultReal} 里面。拒绝执行。\n`);
      process.exit(1);
    }
    if (abs === vaultReal) {
      console.error('\n❌ 源目录不能是整个库根目录 —— 那会把库里所有笔记都发出去。');
      console.error('   请指定一个专门的发布目录，例如 发布留存/网站发布。\n');
      process.exit(1);
    }
  }

  return {
    vault: vaultReal,
    sources,
    outDir: path.resolve(SITE, args.out || cfg.outDir || 'src/content/writing'),
    imageDir: path.resolve(SITE, args.images || cfg.imageDir || 'src/assets/images/writing'),
    defaultTags: cfg.defaultTags ?? [],
    extractInlineTags: cfg.extractInlineTags === true,
    outlineToLists: cfg.outlineToLists !== false,
    // 'source'（默认）只在发布目录里找附件；'vault' 才允许引用库里任何位置的图片
    attachmentScope: (args.attachments || cfg.attachmentScope) === 'vault' ? 'vault' : 'source',
    exclude: cfg.exclude ?? ['_*', '*.excalidraw.md', 'README.md'],
  };
}

function isExcluded(file, vault, excludes) {
  const relPath = path.relative(vault, file).split(path.sep).join('/');
  const base = path.basename(file);
  return excludes.some((pat) => {
    if (pat.startsWith('_')) return relPath.split('/').some((seg) => seg.startsWith('_')) || base.startsWith('_');
    if (pat.startsWith('*.')) return base.endsWith(pat.slice(1));
    return relPath === pat || base === pat;
  });
}

async function run(args) {
  const cfg = await loadConfig(args);
  const dry = !!args.dry;

  // 1. 收集待同步的笔记
  const files = [];
  for (const src of cfg.sources) {
    const dir = path.join(cfg.vault, src.folder);
    if (!existsSync(dir)) {
      warn(`源目录不存在：${src.folder}（在 ${cfg.vault} 下）`);
      continue;
    }
    const all = await walkMd(dir);
    const kept = all.filter((f) => !isExcluded(f, cfg.vault, cfg.exclude));
    for (const f of kept) files.push({ file: f, tags: src.addTags ?? src.tags ?? [] });
  }

  if (args.json) {
    // 只输出机器可读结果
  } else {
    log(`\n📥 库：${cfg.vault}`);
    for (const s of cfg.sources) {
      log(`   ✅ 允许：${s.folder}/`);
    }
    log(`   🚫 其余目录一律不读、不引用`);
    log(`📂 输出 →  ${rel(cfg.outDir)}/`);
    log(`   找到 ${files.length} 篇待处理${dry ? '（--dry 不写文件）' : ''}\n`);
  }

  // 附件索引范围：默认只在「发布目录」里找，别处的图片不引用
  const scopeRoots =
    cfg.attachmentScope === 'vault'
      ? cfg.vault
      : cfg.sources.map((s) => path.join(cfg.vault, s.folder));
  const vaultFiles = await indexVaultFiles(scopeRoots);

  // 2. 第一遍：算出所有 slug，建立双链索引
  const ctxBase = {
    dry,
    vault: cfg.vault,
    vaultFiles,
    outDir: cfg.outDir,
    imageDir: cfg.imageDir,
    extractInlineTags: cfg.extractInlineTags,
    outlineToLists: cfg.outlineToLists,
    targetIndex: new Map(),
  };

  const prelim = [];
  const slugOwner = new Map();
  for (const { file, tags } of files) {
    const raw = await readFile(file, 'utf8');
    const { data, body } = splitFrontmatter(raw);
    const baseName = path.basename(file, '.md');
    const h1 = body.match(/^\s*#\s+(.+?)\s*$/m);
    const title =
      (typeof data.title === 'string' && data.title.trim()) ||
      (h1 ? h1[1].trim() : '') ||
      baseName.replace(/^【\s*\d+\s*】\s*/, '').replace(/[*_`]/g, '').trim();
    const slug = slugify((typeof data.slug === 'string' && data.slug) || title || baseName);
    if (slugOwner.has(slug)) {
      warn(`slug 撞车：「${slug}」同时来自 ${rel(slugOwner.get(slug))} 和 ${rel(file)}，后者会加后缀`);
    }
    slugOwner.set(slug, file);
    prelim.push({ file, tags, title, baseName, slug });
  }
  const usedSlugs = new Map();
  for (const p of prelim) {
    let s = p.slug;
    let i = 2;
    while (usedSlugs.has(s)) s = `${p.slug}-${i++}`;
    usedSlugs.set(s, p.file);
    p.slug = s;
    ctxBase.targetIndex.set(p.baseName, { slug: s, title: p.title });
    ctxBase.targetIndex.set(p.title, { slug: s, title: p.title });
  }

  // 3. 第二遍：真正转换
  const results = [];
  const warnings = [];
  for (const p of prelim) {
    const ctx = {
      ...ctxBase,
      slug: p.slug,
      assets: [],
      notes: [],
      sourceTags: [...cfg.defaultTags, ...p.tags],
      warnings,
    };
    const n = await convertNote(p.file, ctx);
    if (n.skip) {
      log(`   ⏭️  ${p.baseName} —— ${n.skip}`);
      continue;
    }
    n.assets = ctx.assets;
    n.transforms = ctx.notes;
    results.push(n);
  }

  // 4. 写入 + 清理旧的同步产物
  let added = 0,
    updated = 0,
    removed = 0;
  const produced = new Set();

  await mkdir(cfg.outDir, { recursive: true });

  for (const n of results) {
    const dest = path.join(cfg.outDir, `${n.slug}.md`);
    produced.add(path.basename(dest));
    const next = renderNote(n);
    const prev = existsSync(dest) ? await readFile(dest, 'utf8') : null;
    if (prev === next) continue;
    if (prev === null) added++;
    else updated++;
    if (!dry) await writeFile(dest, next, 'utf8');
    if (args.verbose || prev === null)
      log(
        `   ${prev === null ? '✚' : '✎'}  ${n.slug}.md` +
          (n.tags.length ? `   [${n.tags.join(', ')}]` : '') +
          (n.transforms?.length ? `   · ${n.transforms.join('、')}` : '')
      );
  }

  // 图片清单：记录每个 slug 目录下「是同步脚本放进去的」文件，用于安全清理
  if (!dry) {
    for (const n of results) {
      if (!n.assets?.length) continue;
      const dir = path.join(cfg.imageDir, n.slug);
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, IMG_MANIFEST),
        JSON.stringify({ source: n.source, files: n.assets.map((a) => path.basename(a)) }, null, 2)
      );
    }
  }

  // 清理：文章删了 / 换图了，对应的图片也要跟着走，别让仓库里堆垃圾
  let imgRemoved = 0;
  if (existsSync(cfg.imageDir)) {
    const live = new Map(results.map((n) => [n.slug, new Set((n.assets ?? []).map((a) => path.basename(a)))]));
    for (const entry of await readdir(cfg.imageDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(cfg.imageDir, entry.name);
      const mf = path.join(dir, IMG_MANIFEST);
      if (!existsSync(mf)) continue; // 没有清单 → 不是同步脚本管的，绝不碰
      let manifest = {};
      try {
        manifest = JSON.parse(await readFile(mf, 'utf8'));
      } catch {}
      const keep = live.get(entry.name);
      for (const f of manifest.files ?? []) {
        if (keep?.has(f)) continue;
        const target = path.join(dir, f);
        if (existsSync(target)) {
          if (!dry) await rm(target);
          imgRemoved++;
        }
      }
      if (!dry) {
        if (!keep) {
          await rm(mf, { force: true });
          try {
            if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true });
          } catch {}
        } else {
          await writeFile(
            path.join(dir, IMG_MANIFEST),
            JSON.stringify({ source: manifest.source, files: [...keep] }, null, 2)
          );
        }
      }
    }
  }

  for (const f of await readdir(cfg.outDir)) {
    if (!f.endsWith('.md') || produced.has(f)) continue;
    const full = path.join(cfg.outDir, f);
    if (isSynced(await readFile(full, 'utf8'))) {
      if (!dry) await rm(full);
      removed++;
      log(`   ✖  删除 ${f}（源文件已不在发布目录）`);
    } else if (args.verbose) {
      log(`   ·  保留 ${f}（手写文件，没有同步标记）`);
    }
  }

  if (warnings.length) {
    log('');
    for (const w of new Set(warnings)) warn(w);
  }

  if (args.json) {
    console.log(JSON.stringify({ added, updated, removed, total: results.length, warnings: [...new Set(warnings)] }));
  } else {
    log(
      `\n${dry ? '（试运行）' : ''}完成：新增 ${added} · 更新 ${updated} · 删除 ${removed} · 共 ${results.length} 篇` +
        (imgRemoved ? ` · 清理图片 ${imgRemoved} 张` : '')
    );
    if (!dry && (added || updated || removed)) {
      log(`下一步：npm run build   （或 npm run publish 一条龙）\n`);
    } else {
      log('');
    }
  }
  return { added, updated, removed, total: results.length };
}

/* ---------------------------------------------------------- 入口 */

const args = parseArgs(process.argv.slice(2));

if (args.watch) {
  const cfg = await loadConfig(args);
  let timer = null;
  let running = false;
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (running) return;
      running = true;
      try {
        await run(args);
      } catch (e) {
        console.error('同步出错：', e.message);
      }
      running = false;
    }, 400);
  };
  log(`👀 监听中：${cfg.vault}/${cfg.sources.map((s) => s.folder).join('、')}`);
  log('   在 Obsidian 里保存就会自动同步。Ctrl+C 退出。\n');
  await run(args);
  for (const s of cfg.sources) {
    const dir = path.join(cfg.vault, s.folder);
    if (existsSync(dir)) fsWatch(dir, { recursive: true }, trigger);
  }
} else {
  await run(args);
}
