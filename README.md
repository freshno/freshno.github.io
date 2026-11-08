# manjingtou+

> 慢就是快，还要努力。

个人网站。记录文章、项目和日常，支持图文内容。
Astro + Markdown，构建产物是纯 HTML，没有运行时框架。

---

## 快速开始

```bash
npm install
npm run dev        # 本地预览 http://localhost:4321
npm run build      # 构建到 dist/
npm run preview    # 预览构建结果
```

> **注意本机环境**：`npm run build` 必须用系统的 Node（Homebrew 的 `/opt/homebrew/bin/node`，
> v25.x）。DSH 自带的 Node 开了 hardened runtime 的 library validation，
> 会拒绝加载 Rolldown 的原生二进制，导致构建报
> `Cannot find native binding`。如果报这个错，把 `/opt/homebrew/bin` 放到 PATH 最前面即可。

---

## 从 Obsidian 发布（主要写作方式）

**四种内容都在 Obsidian 里写，一条命令同步到网站。**

> 只有 `发布留存/网站发布/` 里面的内容会被读取和发布，库里其他任何目录都不读、不引用。

### 目录结构

```
~/Documents/Obsidian Vault/发布留存/网站发布/
├── 文章/          长文章，每篇一个 .md
├── 项目/          项目卡片，每个一个 .md
├── 日常/          短句 + 照片，每条一个 .md
└── 关于/          关于页，里面放一个 .md（或直接用 关于.md 单文件）
```

**文件夹名可以改**（`obsidian.config.json` 的 `folders`），但右边的四种类型是固定的。

### 三种用法，按懒的程度挑

| 你想要的 | 命令 |
| --- | --- |
| **写完手动发** | `npm run sync` 然后 `npm run build` |
| **边写边看** | `npm run dev` + `npm run sync:watch`（两个终端） |
| **一条命令上线** | `npm run publish -- --push` |

只想看会改什么、不实际写文件：`npm run sync -- --dry`

### 各类型怎么写

**文章**（`文章/我的标题.md`）
```yaml
---
title: 文章标题        # 不写就取文件名或正文里的一级标题
date: 2026-11-08      # 不写就取文件名里的日期，再不行取文件修改时间
tags: [设计, 随笔]
summary: 一句话摘要    # 不写就取正文第一段 / 开头的引用块
draft: false          # true → 只在本地可见
---
正文用 Markdown 写。
```

> 文件名里的 `【0531】` 这类前缀会自动剥掉，不会进标题。

**项目**（`项目/慢读.md`）
```yaml
---
year: 2025                      # 不写取文件年份
status: 在做                     # 在做 / 做完了 / 没做完，写错按「在做」
stack: [TypeScript, SQLite]     # 技术栈
link: https://...               # 可选，有的话整张卡片可点
order: 1                        # 越小越靠前，默认 50
---
一句话项目说明会从正文第一段自动提取。
```

**日常**（`日常/2026-11-08-窗边的桌子.md`）
```yaml
---
location: 杭州        # 可选
---
今天只做一件事。写下来了，就不会一上午都在回消息。
```
- 正文里的图片会自动提取成卡片配图（图在上、文在下），不用手写 `images:` 字段
- 日期优先取文件名开头的 `2026-11-08`

**关于**（`关于/关于.md` 或 `关于.md`）
```yaml
---
doing: 做产品、写代码     # 侧栏「在做」
located: 杭州             # 侧栏「所在」
email: xxx@example.com
---
问候语、关于这个网站、现在、联系我……随便写。
```
版式（左边头像、右边文字）是固定的，只换文字。

### 自动转换的东西

| Obsidian 里写的 | 网站上变成 |
| --- | --- |
| **Tab / 空格缩进的大纲** | **自动转成嵌套列表，保留层级** |
| `[[另一篇]]` | 目标是文章 → 站内链接；否则 → 纯文本 |
| `![[图片.png\|697]]` | 图片复制进站点 + 标准 Markdown（Astro 再转 WebP） |
| `![图](贴图.png)`（发布目录里的本地图） | 同上 —— **不转的话 Astro 会直接构建失败** |
| `> [!note] 标题` | 引用块 |
| `==高亮==` | `<mark>` |
| `%%私密备注%%` | 删掉，不会发出去 |
| 正文开头的 `# 一级标题` | 提升为标题，正文不再重复 |
| `created` / `updated` | `date` |

想精确控制就在 frontmatter 加：`title` / `date` / `tags` / `summary` / `slug`（固定 URL）/ `publish: false`（这篇不发）。

### 几条安全设计

- **目录白名单，三道闸。** ① `root` 配成空 → 拒绝执行；② 越界（`../`）→ 拒绝执行；
  ③ 等于库根 → 拒绝执行。每次运行都打印允许的目录和「其余目录一律不读、不引用」。
- **附件默认也只在发布目录里找**（`attachmentScope: "source"`）。想引用库里任意位置的图片改成 `"vault"`。
- **`publish: false` 或文件名以 `_` 开头的，不会被发布。**
- **手写文件绝不被删。** 同步脚本只删自己生成的产物 —— 靠 frontmatter 里的 `syncedFrom` 标记识别。
- **源文件删了，产物跟着删**，连图片一起清。没有清单的图片目录永远不动。
- **图片找不到时降级成注释 + 警告，不会让构建炸掉。**

### 回归测试

```bash
npm run test:sync
```

51 项断言，覆盖四种类型的转换规则和全部安全边界。改动同步逻辑后跑一下。

## 目录结构

```
src/
├── consts.ts              ← 站点名 / 简介 / 邮箱 / 导航，改这里
├── content.config.ts      ← 三个内容集合的字段定义（写错字段构建就报错）
├── content/
│   ├── writing/           ← 文章，文件名就是 URL（部分由 Obsidian 同步生成）
│   ├── work/              ← 项目
│   └── notes/             ← 日常
├── styles/tokens.css      ← 全站设计令牌，改配色只改这一个文件
├── layouts/Base.astro     ← HTML 骨架、SEO meta、RSS link、防闪烁主题脚本
├── components/            ← 页头 / 页脚 / 列表项 / 项目卡 / 日常卡 / 灯箱 / 订阅
├── lib/
│   ├── rehype-figure.mjs  ← 把独占一行的图片包成 <figure>+<figcaption>
│   └── note-images.ts     ← 日常配图按文件名解析
├── pages/                 ← 路由
└── assets/
    ├── avatar.svg         ← 头像源文件（矢量，可改）
    └── images/
        ├── avatar.png          ← 由 avatar.svg 生成
        ├── notes/              ← 日常配图
        ├── writing/<文章名>/    ← 文章配图（Obsidian 同步时会自动往里放）
        └── raw/                ← 原图暂存（已 gitignore）

scripts/
├── sync-obsidian.mjs      ← Obsidian → 站点同步（转换规则都在这里）
├── publish.mjs            ← 同步 + 构建 + 推送
├── test-sync.mjs          ← 同步逻辑的回归测试
├── images.mjs             ← 手写文章用的图片压缩脚本
├── build-avatar.mjs       ← 头像 SVG → PNG
└── __fixtures__/vault/    ← 测试用的假 Obsidian 库

obsidian.config.json       ← 库路径、发布目录、排除规则
```

---

## 日常写作

### 写一篇文章

新建 `src/content/writing/我的文章.md`，文件名就是 URL（`/writing/我的文章`）：

```yaml
---
title: 文章标题
date: 2026-10-05
tags: [设计, 随笔]
summary: 一句话摘要，会出现在列表页和 RSS 里。
draft: false          # true 则只在本地可见
---

正文用 Markdown 写。

## 二级标题会自动进右侧目录

图片这样写，**方括号里的字就是图注**：

![图注文字](../../assets/images/writing/我的文章/01.jpg)
```

不用管 `<figure>`、`<figcaption>`、图片压缩和 WebP —— 这些在构建时自动完成。

### 加工图片（两步）

```bash
# 1. 把原图丢进 src/assets/images/raw/
# 2. 跑：
npm run img -- writing 我的文章      # 文章配图 → 自动编号 01.jpg 02.jpg
npm run img -- notes                 # 日常配图 → 保留文件名
```

脚本会压到长边 1600px、质量 82、progressive，并**在终端打印可以直接粘贴的 Markdown**。
加 `--dry` 可以只看结果不写文件。

### 记一条日常

新建 `src/content/notes/2026-10-05-一句话.md`：

```yaml
---
date: 2026-10-05
images:
  - src: morning-desk.jpg        # 只写文件名，图片放 src/assets/images/notes/
    caption: 图注，宽屏点开大图时显示
location: 杭州                    # 可选
---

正文写一句就行。**这条会当纯文本渲染，不要写 Markdown 语法。**
```

不写 `images` 就是纯文字条。

### 加一个项目

新建 `src/content/work/项目名.md`：

```yaml
---
title: 项目名
year: 2026 — 现在        # 字符串，写 2026 也行
status: 在做             # 在做 / 做完了 / 没做完，三选一
stack: [Astro, SQLite]
summary: 一句话说明。
link: https://github.com/...   # 可选；有 link 时整张卡可点击
order: 1                       # 越小越靠前
---
```

「没做完的」会自动用另一种版式展示（列表而不是卡片）。

---

## 改外观

**只改 `src/styles/tokens.css`。** 第 2、3 节就是全部设计令牌：

| 变量 | 作用 |
| --- | --- |
| `--bg` / `--bg-subtle` / `--bg-inset` | 底色层级 |
| `--ink-1 … --ink-4` | 文字层级（1 最深） |
| `--line-1 … --line-3` | 发丝线层级 |
| `--accent` | **全站唯一强调色** |
| `--r-sm … --r-panel` | 圆角 |
| `--font-display` | 标题字体（当前是衬线） |
| `--measure` | 正文宽度，40rem ≈ 中文 38 字/行 |
| `--wrap` | 页面宽度 |

默认跟随系统深浅色，也可以用顶栏右侧按钮手动切换，选择存在 `localStorage`。

---

## 发布前必须替换的内容

| 位置 | 现在是什么 | 要改成 |
| --- | --- | --- |
| `astro.config.mjs` 的 `SITE` | `https://example.com` | 你的域名（影响 RSS / sitemap / canonical） |
| `src/consts.ts` | 邮箱、导航 | 已填好你的邮箱；`GITHUB` 留空则不显示 |
| `src/pages/about.astro` | `（待填写）` | 你的「在做」「所在」，以及侧栏 kv |
| `src/pages/about.astro` 「现在」一节 | 占位说明 | 你此刻在做的事 |
| `src/content/**` | 示例文章/项目/日常 | 你的真实内容（或直接删掉重建） |
| `src/assets/images/**` | Unsplash 示例图 | 你自己的照片 |
| `src/assets/avatar.svg` | 原创扁平头像 | 想换就改 SVG 后跑 `npm run avatar` |

站点名、简介已经按你给的信息填好（`manjingtou+` / 慢就是快，还要努力。）。

---

## 部署（GitHub Pages）

网站托在 **GitHub Pages** 上，免费、自带 HTTPS、不限流量。
域名是 `manjingtou01.me`。

### 怎么工作

```
你在 Obsidian 写
      ↓  npm run sync
src/content/writing/  （本地）
      ↓  git push
GitHub 上自动构建（.github/workflows/deploy.yml）
      ↓
https://manjingtou01.me  上线
```

推送到 `main` 分支就会触发自动构建和发布。构建日志在仓库的 **Actions** 页面看。

### 一条命令发布

```bash
npm run publish -- --push
```

它做三件事：从 Obsidian 同步 → 本地先构建一遍（构建失败就不推送，线上保持旧版）→ git 提交并推送。
推上去之后 GitHub 接手，约 1 分钟线上更新。

### 域名和 DNS 是怎么配的

| 记录类型 | 主机记录 | 值 |
| --- | --- | --- |
| A × 4 | `@` | `185.199.108.153` / `.109.153` / `.110.153` / `.111.153` |
| CNAME | `www` | `<你的用户名>.github.io` |

仓库名必须是 `<你的用户名>.github.io`，否则网站地址会多一层、资源路径会裂。
完整的开通步骤（买域名 → 建仓库 → 开 Pages → 配 DNS）写在上一级的 `上线指南.md`。

### 换成别的托管

产物是纯静态文件（`dist/`，1.3 MB），要换 Cloudflare Pages / Vercel / Netlify 随时可以，
把 `astro.config.mjs` 里的 `site` 改掉、重新构建即可。

## 刻意没做的功能

评论、点赞、阅读量统计、站内搜索、标签云、友链页、访问统计仪表盘。

理由：这些功能每一个都会增加维护成本和注意力负担，而它们是「一个博客应该有」的东西，
不是「你真的需要」的东西。想交流留了邮箱，比评论区质量高得多。

---

## 版权说明

`src/assets/avatar.svg` 是**原创扁平插画**，不是官方素材，也没有临摹任何既有作品——
只使用了「银白发 / 深色面罩 / 斜戴护额」这类通用视觉元素的组合。

之所以不用现成的卡卡西图片：该角色著作权属于岸本齐史与集英社，集英社官方 FAQ 明确表示
不对个人授权，且把「用角色制作 logo、icon、壁纸并发布到互联网」列为禁止行为；
公开渠道也不存在可合法商用的卡卡西素材。所以这里走原创路线。
如果你打算换成别的方式，请自行确认授权。

图片素材：示例照片来自 Unsplash（Unsplash License，可免费商用），上线前请替换成你自己的照片。
