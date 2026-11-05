#!/usr/bin/env node
/**
 * manjingtou+ · 图片工作流
 * ---------------------------------------------------------------
 * 目标：从「拍完照」到「出现在文章里」只有两步。
 *
 *   1. 把原图丢进  src/assets/images/raw/
 *   2. npm run img -- writing white-space
 *
 * 脚本会：压到长边 1600px / 质量 82 / progressive → 输出到
 *   src/assets/images/<集合>/<slug>/01.jpg 02.jpg …
 * 并在终端打印可以直接粘进文章的 Markdown。
 *
 * 日常配图（collection = notes）走另一条路：输出到
 *   src/assets/images/notes/<原文件名>.jpg
 * 并打印 frontmatter 片段。
 *
 * 用法：
 *   npm run img -- writing white-space      # 文章配图，顺序编号
 *   npm run img -- notes                    # 日常配图，保留文件名
 *   npm run img -- writing white-space --dry  # 只看结果不写文件
 */

import { readdir, mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = process.cwd();
const RAW = path.join(ROOT, 'src/assets/images/raw');
const OUT_ROOT = path.join(ROOT, 'src/assets/images');

const LONG_EDGE = 1600;
const QUALITY = 82;
const EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tif', '.tiff', '.avif']);

/** 把文件名变成安全的 slug（中文保留，空格转连字符） */
function slugify(name) {
  return name
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'image';
}

function fmtSize(bytes) {
  return (bytes / 1024).toFixed(0) + 'KB';
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== '--dry');
  const dry = process.argv.includes('--dry');
  const [collection, slugArg] = args;

  if (!collection) {
    console.error('用法: npm run img -- <writing|notes> [slug] [--dry]');
    process.exit(1);
  }
  if (!existsSync(RAW)) {
    await mkdir(RAW, { recursive: true });
    console.log(`已创建 ${path.relative(ROOT, RAW)}/，把原图放进去再跑一次。`);
    return;
  }

  const files = (await readdir(RAW)).filter((f) => EXTS.has(path.extname(f).toLowerCase())).sort();
  if (files.length === 0) {
    console.log(`${path.relative(ROOT, RAW)}/ 里没有图片。支持 ${[...EXTS].join(' ')}`);
    return;
  }

  const isNotes = collection === 'notes';
  const outDir = isNotes ? path.join(OUT_ROOT, 'notes') : path.join(OUT_ROOT, collection, slugArg || 'untitled');
  if (!isNotes && !slugArg) {
    console.error('文章配图需要指定 slug：npm run img -- writing white-space');
    process.exit(1);
  }
  if (!dry) await mkdir(outDir, { recursive: true });

  const written = [];
  for (let i = 0; i < files.length; i++) {
    const src = path.join(RAW, files[i]);
    const base = path.basename(files[i], path.extname(files[i]));
    const outName = isNotes ? `${slugify(base)}.jpg` : `${String(i + 1).padStart(2, '0')}.jpg`;
    const dest = path.join(outDir, outName);

    const buf = await sharp(src)
      .rotate() // 按 EXIF 方向摆正
      .resize({
        width: LONG_EDGE,
        height: LONG_EDGE,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: QUALITY, progressive: true, mozjpeg: true })
      .toBuffer();

    if (!dry) await writeFile(dest, buf);
    const meta = await sharp(buf).metadata();
    written.push({ outName, w: meta.width, h: meta.height, size: buf.length });
    console.log(
      `${files[i]}  →  ${outName}   ${meta.width}×${meta.height}   ${fmtSize(buf.length)}${dry ? '  (dry)' : ''}`
    );
  }

  console.log('\n' + '─'.repeat(60));
  if (isNotes) {
    console.log('把下面这段粘进 src/content/notes/<日期>.md 的 frontmatter：\n');
    console.log('images:');
    for (const w of written) {
      console.log(`  - src: ${w.outName}`);
      console.log(`    caption: 这里写图注`);
    }
  } else {
    const rel = `../../assets/images/${collection}/${slugArg}`;
    console.log('把下面这段粘进文章正文（图注写在方括号里）：\n');
    for (const w of written) {
      console.log(`![这里写图注](${rel}/${w.outName})\n`);
    }
  }
  console.log('─'.repeat(60));
  if (!dry) {
    console.log(`\n完成后清空原图目录：rm ${path.relative(ROOT, RAW)}/*`);
  }
}

main().catch((err) => {
  console.error('处理失败：', err.message);
  process.exit(1);
});
