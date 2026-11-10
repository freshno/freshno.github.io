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
      .replace(/[*_`~<>:"/\\|?]+/g, '-')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/-+/g, '-')
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
    ctx.warnings.push(`图片找不到：「${clean}」不在发布目录里，已跳过（该图不会出现在网站上）`);
    return null;
  }
  const safeName = path.basename(src).replace(/[^\p{L}\p{N}._-]+/gu, '-');
  // 文章/项目：每篇一个文件夹（src/assets/images/writing/<slug>/）
  // 日常：所有配图平铺在一个文件夹里（src/assets/images/notes/），所以加 slug 前缀防重名
  const flat = ctx.imagesPerSlug === false;
  const destDir = flat ? ctx.imageDir : path.join(ctx.imageDir, ctx.slug);
  const fileName = flat ? `${ctx.slug}-${safeName}` : safeName;
  const dest = path.join(destDir, fileName);
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

/** 从文件名里取日期：2026-11-08-窗边的桌子.md → 2026-11-08 */
function dateFromFilename(name) {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
  return Number.isNaN(d.valueOf()) ? null : d;
}

/** 项目状态只认这三个词，写错或没写就按「在做」 */
const WORK_STATUS = ['在做', '做完了', '没做完'];

/**
 * 日常笔记的配图走 frontmatter，不走正文 ——
 * 因为日常卡片是「图在上、文字在下」的固定结构。
 * 所以把正文里的图片抽出来，返回图片清单 + 去掉图片后的文字。
 */
function extractNoteImages(body) {
  const images = [];
  const cleaned = body.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_w, alt, href) => {
    images.push({ src: path.basename(href), caption: (alt || '').trim() });
    return '';
  });
  return { body: cleaned, images };
}

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

  // slug 由 runType 统一算好（含去重、「关于」的固定文件名），这里直接用，
  // 不要在这里重算 —— 否则两处算法一旦分叉就会打架。
  const slug =
    ctx.slug || slugify((typeof data.slug === 'string' && data.slug) || title || baseName);

  let st;
  try {
    st = await stat(file);
  } catch {
    st = { mtime: new Date() };
  }
  // 日期来源分三种，后面要靠它判断「这个日期稳不稳」：
  //   frontmatter → 你手写的，最权威
  //   filename    → 文件名里的日期，稳定
  //   mtime       → 文件修改时间，**不稳定**（改个错别字就变）
  const explicitDate = toDate(data.date) || toDate(data.created) || toDate(data.updated);
  const nameDate = dateFromFilename(baseName);
  const date = explicitDate || nameDate || st.mtime;
  const dateSource = explicitDate ? 'frontmatter' : nameDate ? 'filename' : 'mtime';

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

  // 日常：「图片在上、文字在下」是卡片固定结构，所以把图提到 frontmatter 里
  let images = [];
  if (ctx.type === 'notes') {
    const r = extractNoteImages(body);
    images = r.images;
    body = tidyBody(r.body, title);
    if (images.length) ctx.notes.push('图片 → 卡片配图');
  }

  const tags = [...new Set([...ctx.sourceTags, ...inlineTags, ...rawTags])];
  const summary = makeSummary(data, body);

  const n = {
    slug,
    // 记成「相对库根」的路径：可读、可移植，不会把本机目录结构写进仓库
    source: path.relative(ctx.vault, file).split(path.sep).join('/'),
    title,
    date,
    tags,
    summary,
    draft: data.draft === true,
    body,
    images,
    dateSource,
    warnings: [],
  };

  // ── 各类型专属字段 ──
  if (ctx.type === 'work') {
    const status = String(data.status ?? '').trim();
    n.year =
      data.year != null && String(data.year).trim()
        ? String(data.year).trim()
        : String(date.getFullYear());
    n.status = WORK_STATUS.includes(status) ? status : '在做';
    if (!WORK_STATUS.includes(status)) {
      ctx.notes.push(`状态没填，按「在做」处理`);
    }
    n.stack = []
      .concat(data.stack ?? data.tech ?? [])
      .flatMap((t) => (Array.isArray(t) ? t : [t]))
      .filter((t) => typeof t === 'string')
      .map((t) => t.trim())
      .filter(Boolean);
    n.link =
      typeof data.link === 'string'
        ? data.link.trim()
        : typeof data.url === 'string'
          ? data.url.trim()
          : '';
    n.order = Number.isFinite(Number(data.order)) ? Number(data.order) : 50;
  }

  if (ctx.type === 'page') {
    n.doing = typeof data.doing === 'string' ? data.doing.trim() : '';
    n.located = typeof data.located === 'string' ? data.located.trim() : '';
    n.email = typeof data.email === 'string' ? data.email.trim() : '';
    // 关于页里这些字段是可选的，空着就不写进 frontmatter
  }

  return n;
}

function yamlList(arr) {
  return `[${arr.map(yamlScalar).join(', ')}]`;
}

/** 按内容类型生成 frontmatter —— 每类集合要求的字段不一样 */
function renderNote(n, t) {
  const L = ['---', `title: ${yamlScalar(n.title)}`];

  if (t.type === 'writing') {
    L.push(
      `date: ${ymd(n.date)}`,
      `tags: ${yamlList(n.tags)}`,
      `summary: ${yamlScalar(n.summary || n.title)}`
    );
    if (n.draft) L.push('draft: true');
  } else if (t.type === 'work') {
    L.push(
      `year: ${yamlScalar(n.year)}`,
      `status: ${n.status}`,
      `stack: ${yamlList(n.stack)}`,
      `summary: ${yamlScalar(n.summary || n.title)}`
    );
    if (n.link) L.push(`link: ${yamlScalar(n.link)}`);
    L.push(`order: ${n.order}`);
  } else if (t.type === 'notes') {
    L.push(`date: ${ymd(n.date)}`);
    if (n.images.length) {
      L.push('images:');
      for (const im of n.images) {
        L.push(`  - src: ${yamlScalar(im.src)}`);
        L.push(`    caption: ${yamlScalar(im.caption)}`);
      }
    } else {
      L.push('images: []');
    }
  } else if (t.type === 'page') {
    if (n.doing) L.push(`doing: ${yamlScalar(n.doing)}`);
    if (n.located) L.push(`located: ${yamlScalar(n.located)}`);
    if (n.email) L.push(`email: ${yamlScalar(n.email)}`);
  }

  L.push(`${MARK}: ${yamlScalar(n.source)}`, '---', '');
  return L.join('\n') + n.body;
}

/** 判断一个产物文件是不是同步脚本生成的（手写文件绝不动） */
function isSynced(text) {
  const head = text.slice(0, 600);
  const m = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return !!m && new RegExp(`^${MARK}:`, 'm').test(m[1]);
}

/* ---------------------------------------------------------- 主流程 */

/** 四类内容：Obsidian 里的子文件夹 → 站点的内容集合 */
const TYPE_DEFS = {
  writing: {
    label: '文章',
    outDir: 'src/content/writing',
    imageDir: 'src/assets/images/writing',
    imagesPerSlug: true, // 每篇一个图片文件夹
  },
  work: {
    label: '项目',
    outDir: 'src/content/work',
    imageDir: 'src/assets/images/work',
    imagesPerSlug: true,
  },
  notes: {
    label: '日常',
    outDir: 'src/content/notes',
    imageDir: 'src/assets/images/notes',
    imagesPerSlug: false, // 所有配图平铺在一个文件夹里
  },
  page: {
    label: '关于',
    outDir: 'src/content/pages',
    imageDir: 'src/assets/images/pages',
    imagesPerSlug: true,
    fixedSlug: 'about', // 关于永远只有一页
  },
};

/** 默认的文件夹名，可以在 obsidian.config.json 的 folders 里改 */
const DEFAULT_FOLDERS = { 文章: 'writing', 项目: 'work', 日常: 'notes', 关于: 'page' };

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

  // 「没配」和「配成空字符串」要区别对待：
  //   没配 → 用默认发布目录（方便）
  //   配成空的 → 当作配置错误，直接拒绝（避免悄悄换了发布目录）
  const hasRootKey = Object.prototype.hasOwnProperty.call(cfg, 'root');
  const rootRel = args.folder || (hasRootKey ? cfg.root : '发布留存/网站发布');
  const rootAbs = path.resolve(vaultReal, String(rootRel || ''));

  // ── 目录白名单守卫 ─────────────────────────────────────────────
  // 「别的文件夹禁止使用」是硬要求，不能靠自觉。三道闸：
  //   1. 必须有明确的发布目录（空配置直接拒绝，绝不退化成"整个库"）
  //   2. 发布目录必须真的在库里面（挡住 .. 和绝对路径逃逸）
  //   3. 发布目录不能等于库根（那等于全库同步）
  if (!rootRel || !String(rootRel).trim()) {
    console.error('\n❌ obsidian.config.json 里没有配置发布目录 root。');
    console.error('   为避免误发整个库，这里直接拒绝执行。\n');
    process.exit(1);
  }
  const insideVault = rootAbs === vaultReal || rootAbs.startsWith(vaultReal + path.sep);
  if (!insideVault) {
    console.error(`\n❌ 发布目录越界：${rootRel}`);
    console.error(`   解析后是 ${rootAbs}，不在库 ${vaultReal} 里面。拒绝执行。\n`);
    process.exit(1);
  }
  if (rootAbs === vaultReal) {
    console.error('\n❌ 发布目录不能是整个库根目录 —— 那会把库里所有笔记都发出去。');
    console.error('   请指定一个专门的发布目录，例如 发布留存/网站发布。\n');
    process.exit(1);
  }

  const folders = { ...DEFAULT_FOLDERS, ...(cfg.folders || {}) };
  const excludes = cfg.exclude ?? ['_*', '*.excalidraw.md', 'README.md'];

  // 把「子文件夹 → 内容类型」解析成绝对路径。目录还没建的类型安静跳过。
  const types = [];
  for (const [folderName, typeKey] of Object.entries(folders)) {
    const def = TYPE_DEFS[typeKey];
    if (!def) {
      warn(`配置里的「${folderName}」对不上任何内容类型（${typeKey}），已忽略`);
      continue;
    }
    const asDir = path.join(rootAbs, folderName);
    const asFile = path.join(rootAbs, folderName + '.md');
    let sourceDir = null;
    let sourceFile = null;
    if (existsSync(asDir) && (await stat(asDir)).isDirectory()) sourceDir = asDir;
    else if (existsSync(asFile)) sourceFile = asFile;
    else continue;

    const outDir = args.out
      ? path.resolve(args.out, typeKey)
      : path.resolve(SITE, def.outDir);
    const imageDir = args.images
      ? def.imagesPerSlug
        ? path.resolve(args.images, typeKey)
        : path.resolve(args.images)
      : path.resolve(SITE, def.imageDir);

    types.push({
      type: typeKey,
      label: def.label,
      folderName,
      sourceDir,
      sourceFile,
      outDir,
      imageDir,
      imagesPerSlug: def.imagesPerSlug !== false,
      fixedSlug: def.fixedSlug,
    });
  }

  return {
    vault: vaultReal,
    root: rootAbs,
    rootRel,
    types,
    defaultTags: cfg.defaultTags ?? [],
    extractInlineTags: cfg.extractInlineTags === true,
    outlineToLists: cfg.outlineToLists !== false,
    // 'source'（默认）只在发布目录里找附件；'vault' 才允许引用库里任何位置的图片
    attachmentScope: (args.attachments || cfg.attachmentScope) === 'vault' ? 'vault' : 'source',
    exclude: excludes,
  };
}

function isExcluded(file, base, excludes) {
  const relPath = path.relative(base, file).split(path.sep).join('/');
  const name = path.basename(file);
  return excludes.some((pat) => {
    if (pat.startsWith('_')) {
      return relPath.split('/').some((seg) => seg.startsWith('_')) || name.startsWith('_');
    }
    if (pat.startsWith('*.')) return name.endsWith(pat.slice(1));
    return relPath === pat || name === pat;
  });
}

/** 处理一个内容类型：扫描 → 算 slug → 转换 → 写入 → 清理 */
async function runType(cfg, t, args, vaultFiles, targetIndex) {
  const dry = !!args.dry;

  // 1. 收集文件
  let files = [];
  if (t.sourceFile) files = [t.sourceFile];
  else if (t.sourceDir) files = await walkMd(t.sourceDir);
  files = files.filter((f) => !isExcluded(f, cfg.root, cfg.exclude));

  // 2. 算 slug
  const prelim = [];
  const usedSlugs = new Set();
  for (const file of files) {
    const raw = await readFile(file, 'utf8');
    const { data, body } = splitFrontmatter(raw);
    if (data.publish === false) continue;
    const baseName = path.basename(file, '.md');
    const h1 = body.match(/^\s*#\s+(.+?)\s*$/m);
    const title =
      (typeof data.title === 'string' && data.title.trim()) ||
      (h1 ? h1[1].trim() : '') ||
      baseName.replace(/^【\s*\d+\s*】\s*/, '').replace(/[*_`]/g, '').trim();

    let slug;
    if (t.fixedSlug) {
      slug = t.fixedSlug;
    } else {
      slug = slugify((typeof data.slug === 'string' && data.slug) || title || baseName);
      const base = slug;
      let i = 2;
      while (usedSlugs.has(slug)) slug = `${base}-${i++}`;
      usedSlugs.add(slug);
    }

    prelim.push({ file, baseName, title, slug });

    // 只有文章有详情页，才能当双链目标；项目和日常没有详情页，只保留文本
    if (t.type === 'writing') {
      targetIndex.set(baseName, { slug, title });
      targetIndex.set(title, { slug, title });
    }
  }

  // 3. 转换
  const results = [];
  const warnings = [];
  for (const p of prelim) {
    const ctx = {
      type: t.type,
      dry,
      vault: cfg.vault,
      vaultFiles,
      outDir: t.outDir,
      imageDir: t.imageDir,
      imagesPerSlug: t.imagesPerSlug,
      extractInlineTags: cfg.extractInlineTags,
      outlineToLists: cfg.outlineToLists,
      targetIndex,
      slug: p.slug,
      assets: [],
      notes: [],
      sourceTags: cfg.defaultTags,
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

  // 4. 写入
  let added = 0;
  let updated = 0;
  let removed = 0;
  const produced = new Set();
  await mkdir(t.outDir, { recursive: true });

  for (const n of results) {
    const dest = path.join(t.outDir, `${n.slug}.md`);
    produced.add(path.basename(dest));
    const prev = existsSync(dest) ? await readFile(dest, 'utf8') : null;

    // 日期稳定性：如果这次算出来的日期来自「文件修改时间」（说明你没写 date），
    // 就沿用上一次发布的日期 —— 否则改个错别字会把老文章的发布日期改到今天，
    // 整篇文章会莫名其妙跳到首页最前面。
    if (prev && n.dateSource === 'mtime') {
      const m = prev.match(/^date:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
      const kept = m && toDate(m[1]);
      if (kept) {
        n.date = kept;
        n.transforms = [...(n.transforms ?? []), '沿用原发布日期'];
      }
    }

    const next = renderNote(n, t);
    if (prev === next) continue;
    if (prev === null) added++;
    else updated++;
    if (!dry) await writeFile(dest, next, 'utf8');
    if (args.verbose || prev === null) {
      log(
        `   ${prev === null ? '✚' : '✎'}  [${t.label}] ${n.slug}.md` +
          (n.tags?.length ? `   [${n.tags.join(', ')}]` : '') +
          (n.transforms?.length ? `   · ${n.transforms.join('、')}` : '')
      );
    }
  }

  // 5. 图片清单 + 清理旧图
  let imgRemoved = 0;
  if (t.imagesPerSlug) {
    if (!dry) {
      for (const n of results) {
        if (!n.assets?.length) continue;
        const dir = path.join(t.imageDir, n.slug);
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, IMG_MANIFEST),
          JSON.stringify(
            { source: n.source, files: n.assets.map((a) => path.basename(a)) },
            null,
            2
          )
        );
      }
    }
    if (existsSync(t.imageDir)) {
      const live = new Map(
        results.map((n) => [n.slug, new Set((n.assets ?? []).map((a) => path.basename(a)))])
      );
      for (const entry of await readdir(t.imageDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(t.imageDir, entry.name);
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
  } else {
    // 日常：图片平铺在一个文件夹里，用一份总清单记录哪些是同步脚本放的
    const mf = path.join(t.imageDir, IMG_MANIFEST);
    const current = new Set(results.flatMap((n) => (n.assets ?? []).map((a) => path.basename(a))));
    let previous = [];
    try {
      previous = JSON.parse(await readFile(mf, 'utf8')).files ?? [];
    } catch {}
    for (const f of previous) {
      if (current.has(f)) continue;
      const target = path.join(t.imageDir, f);
      if (existsSync(target)) {
        if (!dry) await rm(target);
        imgRemoved++;
      }
    }
    if (!dry && current.size) {
      await mkdir(t.imageDir, { recursive: true });
      await writeFile(mf, JSON.stringify({ files: [...current] }, null, 2));
    }
  }

  // 6. 清理：源文件删了，产物跟着删（手写文件没有同步标记，绝不动）
  for (const f of await readdir(t.outDir)) {
    if (!f.endsWith('.md') || produced.has(f)) continue;
    const full = path.join(t.outDir, f);
    if (isSynced(await readFile(full, 'utf8'))) {
      if (!dry) await rm(full);
      removed++;
      log(`   ✖  删除 [${t.label}] ${f}（源文件已不在发布目录）`);
    } else if (args.verbose) {
      log(`   ·  保留 [${t.label}] ${f}（手写文件，没有同步标记）`);
    }
  }

  return { added, updated, removed, imgRemoved, total: results.length, warnings };
}

async function run(args) {
  const cfg = await loadConfig(args);
  const dry = !!args.dry;

  // 一个内容类型都没建
  if (!cfg.types.length) {
    log(`\n📥 库：${cfg.vault}`);
    log(`📂 发布目录：${cfg.rootRel}/`);
    log(`\n⚠️  这个目录里还没有任何内容文件夹。请在 Obsidian 里建：`);
    for (const [name, key] of Object.entries(DEFAULT_FOLDERS)) {
      log(`     ${name}${key === 'page' ? '.md' : '/'}  → ${TYPE_DEFS[key].label}`);
    }
    log('');
    return { added: 0, updated: 0, removed: 0, total: 0 };
  }

  if (!args.json) {
    log(`\n📥 库：${cfg.vault}`);
    log(`   ✅ 允许：${cfg.rootRel}/`);
    log(`   🚫 其余目录一律不读、不引用`);
    log(
      `📂 内容类型：` +
        cfg.types
          .map((t) =>
            t.label === t.folderName
              ? `${t.folderName}${t.sourceDir ? '/' : '.md'}`
              : `${t.folderName}${t.sourceDir ? '/' : '.md'}（${t.label}）`
          )
          .join('  ·  ')
    );
    log('');
  }

  const scopeRoots = cfg.attachmentScope === 'vault' ? cfg.vault : [cfg.root];
  const vaultFiles = await indexVaultFiles(scopeRoots);
  const targetIndex = new Map();

  const sum = { added: 0, updated: 0, removed: 0, imgRemoved: 0, total: 0 };
  const allWarnings = [];

  for (const t of cfg.types) {
    if (!args.json) {
      const head = t.label === t.folderName ? t.label : `${t.folderName}（${t.label}）`;
      log(`── ${head} → ${rel(t.outDir)}/`);
    }
    const r = await runType(cfg, t, args, vaultFiles, targetIndex);
    sum.added += r.added;
    sum.updated += r.updated;
    sum.removed += r.removed;
    sum.imgRemoved += r.imgRemoved;
    sum.total += r.total;
    allWarnings.push(...r.warnings);
    if (!args.json) {
      const changed = r.added || r.updated || r.removed;
      log(`   ${changed ? '' : '（无变化）'}共 ${r.total} 条`);
      log('');
    }
  }

  const uniqWarnings = [...new Set(allWarnings)];
  if (uniqWarnings.length && !args.json) {
    for (const w of uniqWarnings) warn(w);
    log('');
  }

  if (args.json) {
    console.log(JSON.stringify({ ...sum, warnings: uniqWarnings }));
  } else {
    log(
      `${dry ? '（试运行）' : ''}合计：新增 ${sum.added} · 更新 ${sum.updated} · 删除 ${sum.removed}` +
        ` · 共 ${sum.total} 条` +
        (sum.imgRemoved ? ` · 清理图片 ${sum.imgRemoved} 张` : '')
    );
    if (!dry && (sum.added || sum.updated || sum.removed)) {
      log(`下一步：npm run build   （或 npm run publish 一条龙）\n`);
    } else {
      log('');
    }
  }
  return sum;
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
  log(`👀 监听中：${cfg.vault}/${cfg.rootRel}`);
  log('   在 Obsidian 里保存就会自动同步。Ctrl+C 退出。\n');
  await run(args);
  if (existsSync(cfg.root)) fsWatch(cfg.root, { recursive: true }, trigger);
} else {
  await run(args);
}
