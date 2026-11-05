import type { APIContext } from 'astro';

/** 动态生成：这样 sitemap 地址永远跟 astro.config.mjs 里的 site 一致 */
export async function GET({ site }: APIContext) {
  const base = (site ?? 'https://example.com').href.replace(/\/$/, '');
  return new Response(
    `User-agent: *\nAllow: /\n\nSitemap: ${base}/sitemap-index.xml\n`,
    { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
  );
}
