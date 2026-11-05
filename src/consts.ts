/** 站点常量：要改名字、简介、联系方式，只改这个文件。 */

export const SITE_NAME = 'manjingtou+';
export const SITE_TAGLINE = '慢就是快，还要努力。';
export const SITE_DESC =
  'manjingtou+ —— 慢就是快，还要努力。这里放写完的文章、做完和没做完的项目，还有一些不值得单独成文、但不想就这么过去的日常。';

export const AUTHOR = 'manjingtou+';
export const EMAIL = 'jtma372804@gmail.com';
/** 没有就留空字符串，页脚会自动隐藏整个「联系」项 */
export const GITHUB = '';
export const LOCATION = '';

/** 从 astro.config.mjs 的 site 读取，一处生效 */
export const SITE_URL = import.meta.env.SITE ?? 'https://example.com';

export const NAV = [
  { href: '/', label: '首页' },
  { href: '/writing', label: '文章' },
  { href: '/work', label: '项目' },
  { href: '/notes', label: '日常' },
  { href: '/about', label: '关于' },
] as const;
