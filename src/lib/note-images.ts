/**
 * 日常配图解析。
 * 作者在 frontmatter 里只写文件名：  src: morning-desk.jpg
 * 图片实际放：src/assets/images/notes/
 * 这样换图床、换目录都不用改文章。
 */
const modules = import.meta.glob<{ default: ImageMetadata }>(
  '/src/assets/images/notes/*.{jpg,jpeg,png,webp,avif}',
  { eager: true }
);

const PREFIX = '/src/assets/images/notes/';

export function noteImage(name: string): ImageMetadata | undefined {
  const hit = modules[PREFIX + name];
  if (!hit) {
    console.warn(
      `[notes] 找不到配图「${name}」。请确认它存在于 src/assets/images/notes/ 且扩展名正确。`
    );
    return undefined;
  }
  return hit.default;
}
