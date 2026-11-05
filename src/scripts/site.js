/* ============================================================
   manjingtou+ · 前端交互
   无依赖。主题存 localStorage，刷新不丢。
   四件事：主题切换 / 图片灯箱 / 文章标签筛选 / 目录滚动高亮
   ============================================================ */
(function () {
  'use strict';

  var LS_THEME = 'mjt.theme';

  function qsa(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  /* ---------- 主题 ---------- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute('content', t === 'dark' ? '#151517' : '#ffffff');
  }

  function initTheme() {
    qsa('[data-theme-toggle]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next =
          document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        try {
          localStorage.setItem(LS_THEME, next);
        } catch (e) {}
      });
    });
    // 同步 meta theme-color（<head> 里的内联脚本已设好 data-theme）
    applyTheme(document.documentElement.getAttribute('data-theme') || 'light');
  }

  /* ---------- 灯箱 ---------- */
  function initLightbox() {
    var box = document.querySelector('[data-lightbox]');
    if (!box) return;
    var img = box.querySelector('img');
    var cap = box.querySelector('.cap');

    function open(src, text) {
      img.setAttribute('src', src);
      img.setAttribute('alt', text || '');
      cap.textContent = text || '';
      cap.style.display = text ? '' : 'none';
      box.setAttribute('data-open', 'true');
      document.body.style.overflow = 'hidden';
      box.querySelector('[data-close]').focus();
    }
    function close() {
      box.setAttribute('data-open', 'false');
      document.body.style.overflow = '';
      img.removeAttribute('src');
    }

    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-zoom]');
      if (!t) return;
      e.preventDefault();
      // 正文 figure：图注在同级 figcaption
      var fig = t.closest('figure');
      var text =
        t.getAttribute('data-cap') ||
        (fig && fig.querySelector('figcaption') ? fig.querySelector('figcaption').textContent : '');
      var inner = t.tagName === 'IMG' ? t : t.querySelector('img');
      open((inner && inner.currentSrc) || (inner && inner.getAttribute('src')) || t.getAttribute('data-zoom'), text);
    });

    box.addEventListener('click', function (e) {
      if (e.target === box || e.target.closest('[data-close]')) close();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && box.getAttribute('data-open') === 'true') close();
    });
  }

  /* ---------- 文章标签筛选 ---------- */
  function initFilter() {
    var bar = document.querySelector('[data-filter-bar]');
    if (!bar) return;
    var items = qsa('[data-tags]');
    var countEl = bar.querySelector('[data-count]');
    var current = '全部';

    function run() {
      var shown = 0;
      items.forEach(function (el) {
        var tags = (el.getAttribute('data-tags') || '').split('|');
        var ok = current === '全部' || tags.indexOf(current) !== -1;
        el.style.display = ok ? '' : 'none';
        if (ok) shown++;
      });
      qsa('[data-year-block]').forEach(function (b) {
        var any = qsa('[data-tags]', b).some(function (el) {
          return el.style.display !== 'none';
        });
        b.style.display = any ? '' : 'none';
      });
      var empty = document.querySelector('[data-empty]');
      if (empty) empty.style.display = shown ? 'none' : '';
      if (countEl) countEl.textContent = shown + ' 篇';
    }

    bar.addEventListener('click', function (e) {
      var b = e.target.closest('[data-filter]');
      if (!b) return;
      current = b.getAttribute('data-filter');
      qsa('[data-filter]', bar).forEach(function (x) {
        x.setAttribute('aria-pressed', String(x === b));
      });
      run();
    });
    run();
  }

  /* ---------- 目录滚动高亮 ---------- */
  function initToc() {
    var toc = document.querySelector('[data-toc]');
    if (!toc || !('IntersectionObserver' in window)) return;
    var links = qsa('a', toc);
    var heads = links
      .map(function (a) {
        return document.querySelector(a.getAttribute('href'));
      })
      .filter(Boolean);
    if (!heads.length) return;

    var visible = new Set();
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) visible.add(en.target);
          else visible.delete(en.target);
        });
        var active =
          heads.find(function (h) {
            return visible.has(h);
          }) || heads[0];
        links.forEach(function (a) {
          a.classList.toggle('is-current', a.getAttribute('href') === '#' + active.id);
        });
      },
      { rootMargin: '-84px 0px -70% 0px', threshold: 0 }
    );
    heads.forEach(function (h) {
      io.observe(h);
    });
  }

  function boot() {
    initTheme();
    initLightbox();
    initFilter();
    initToc();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
