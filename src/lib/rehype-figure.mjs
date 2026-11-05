/**
 * 把 markdown 里「独占一段的图片」包成 <figure> + <figcaption>。
 *
 * 作者的写法保持最简：
 *     ![三月，窗边的桌子](./desk.jpg)
 * 产出：
 *     <figure><img src="...（Astro 已优化）" data-zoom><figcaption>三月，窗边的桌子</figcaption></figure>
 *
 * 兼容两种情况：Astro 图片管线可能产出 <img>，也可能产出 <picture><source/><img/></picture>。
 * 刻意不依赖 unist-util-visit，用原生递归，避免多一个依赖。
 */

/** 深度优先找到所有 <img>，无论是否被 <picture> 包着 */
function findImgs(node, out = []) {
  if (!node || !node.children) return out;
  if (node.tagName === 'img') out.push(node);
  for (const c of node.children) findImgs(c, out);
  return out;
}

/** 判断一个元素是不是「纯图片容器」：<img> 或 <picture> 里只有一个 <img> */
function isPictureLike(node) {
  if (!node || !node.children) return false;
  if (node.tagName === 'img') return true;
  if (node.tagName === 'picture') {
    const imgs = node.children.filter((c) => c.tagName === 'img');
    const others = node.children.filter((c) => c.tagName !== 'img' && c.tagName !== 'source');
    return imgs.length === 1 && others.length === 0;
  }
  return false;
}

function markZoom(node) {
  for (const img of findImgs(node)) {
    img.properties = img.properties || {};
    img.properties['data-zoom'] = '';
  }
}

/**
 * 只有「有意义的」alt 才变成图注。
 * Obsidian 剪藏、推特复制过来的图，alt 经常是 Image / 图像 / 截屏2026-06-05 之类，
 * 把它们渲染成居中的图注只是视觉噪音，还不如不显示。
 */
const MEANINGLESS = /^(image|img|picture|photo|pic|screenshot|untitled|图片|图像|照片|截图|配图|未命名)\s*\d*$/i;

function isMeaningfulCaption(text) {
  const t = String(text || '').trim();
  if (t.length < 2) return false;
  if (MEANINGLESS.test(t)) return false;
  if (/^(pasted|截屏|screenshot|screen ?shot)[\s_-]*image[\s_-]*[\d\s.:-]*$/i.test(t)) return false;
  if (/^[\w\s.-]+\.(png|jpe?g|gif|webp|avif)$/i.test(t)) return false;
  if (!/[\p{L}\p{N}]/u.test(t)) return false;
  return true;
}

function figure(pictureNode, alt) {
  markZoom(pictureNode);
  const children = [pictureNode];
  if (isMeaningfulCaption(alt)) {
    children.push({
      type: 'element',
      tagName: 'figcaption',
      properties: {},
      children: [{ type: 'text', value: String(alt).trim() }],
    });
  }
  return { type: 'element', tagName: 'figure', properties: {}, children };
}

export default function rehypeFigure() {
  return (tree) => {
    /** @param {any} node */
    const walk = (node) => {
      if (!node || !Array.isArray(node.children)) return;
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];

        // ① 独占一段的图片：<p><img/></p> 或 <p><picture/></p>
        if (child.tagName === 'p' && child.children.length === 1 && isPictureLike(child.children[0])) {
          const holder = child.children[0];
          const alt = findImgs(holder)[0]?.properties?.alt || '';
          node.children[i] = figure(holder, alt);
          continue;
        }

        // ② 混在文字里的行内图片：只加 data-zoom，不包 figure（图注放段中会破坏语义）
        if (child.tagName === 'img') {
          child.properties = child.properties || {};
          child.properties['data-zoom'] = '';
        }

        walk(child);
      }
    };
    walk(tree);
  };
}
