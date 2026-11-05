import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * 三条内容线。字段固定，写的时候不用想。
 * 文件名即 URL：src/content/writing/white-space.md  →  /writing/white-space
 */

const writing = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/writing' }),
  schema: z.object({
    title: z.string(),
    date: z.coerce.date(),
    tags: z.array(z.string()).default([]),
    summary: z.string(),
    draft: z.boolean().default(false),
  }),
});

const work = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/work' }),
  schema: z.object({
    title: z.string(),
    // 允许写 2023（数字）或 2026 — 现在（字符串），统一成字符串
    year: z.coerce.string(),
    status: z.enum(['在做', '做完了', '没做完']),
    stack: z.array(z.string()).default([]),
    summary: z.string(),
    link: z.string().optional(),
    order: z.number().default(99),
  }),
});

const notes = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/notes' }),
  schema: z.object({
    date: z.coerce.date(),
    /** src 只写文件名，图片放 src/assets/images/notes/ */
    images: z
      .array(z.object({ src: z.string(), caption: z.string() }))
      .default([]),
    location: z.string().optional(),
  }),
});

export const collections = { writing, work, notes };
