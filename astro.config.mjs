// @ts-check
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import sitemap from '@astrojs/sitemap';
import rehypeFigure from './src/lib/rehype-figure.mjs';

// 站点正式地址。改这一处，RSS / sitemap / 分享卡片 / 搜索引擎收录地址全部跟着变
const SITE = process.env.SITE_URL || 'https://manjingtou01.com';

export default defineConfig({
  site: SITE,
  trailingSlash: 'ignore',
  integrations: [sitemap()],
  markdown: {
    // 把「独占一行的图片」自动包成 <figure><figcaption>图注</figcaption></figure>
    // 作者的写法保持最简：  ![图注文字](./图的相对路径.jpg)
    processor: unified({ rehypePlugins: [rehypeFigure] }),
    // 代码高亮跟随站点明暗，而不是固定成某个深色主题
    // defaultColor: false → 不写内联色，改用 --shiki-light / --shiki-dark 变量
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark-dimmed' },
      defaultColor: false,
      wrap: false,
    },
  },
  image: {
    // 正文里的 markdown 图片也走响应式：生成 srcset + WebP
    layout: 'constrained',
    responsiveStyles: true,
  },
});
