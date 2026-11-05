import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';
import * as C from '../consts';

export async function GET(context: APIContext) {
  const posts = (await getCollection('writing', ({ data }) => !data.draft)).sort(
    (a, b) => b.data.date.valueOf() - a.data.date.valueOf()
  );

  return rss({
    title: C.SITE_NAME,
    description: C.SITE_TAGLINE,
    site: context.site ?? C.SITE_URL,
    items: posts.map((post) => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.summary,
      link: `/writing/${post.id}/`,
      categories: post.data.tags,
    })),
    customData: '<language>zh-cn</language>',
  });
}
