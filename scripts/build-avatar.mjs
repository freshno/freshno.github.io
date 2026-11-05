#!/usr/bin/env node
/**
 * 重建头像 PNG。
 * 源文件是矢量 SVG（src/assets/avatar.svg），改颜色/比例只要改那个文件，
 * 然后跑：npm run avatar
 */
import { readFile, writeFile } from 'node:fs/promises';
import sharp from 'sharp';

const SRC = 'src/assets/avatar.svg';
const OUT = 'src/assets/images/avatar.png';

const svg = await readFile(SRC);
const info = await sharp(svg, { density: 300 })
  .resize(1200, 1500, { fit: 'cover' })
  .png({ compressionLevel: 9 })
  .toFile(OUT);

console.log(`头像已重建 → ${OUT}  ${info.width}×${info.height}  ${(info.size / 1024).toFixed(0)}KB`);
