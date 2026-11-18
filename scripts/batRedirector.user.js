// ==UserScript==
// @name         Bat Redirector
// @namespace    /TFBUtils/BatRedirector
// @version      1.0.0.0
// @description  Replaces and redirects instances of Firebat's @handle URL with her Channel ID URL :D
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      raw.githubusercontent.com
// @updateURL    https://raw.githubusercontent.com/TFBUtils/BatRedirector/stable/scripts/batRedirector.user.js
// @downloadURL  https://raw.githubusercontent.com/TFBUtils/BatRedirector/stable/scripts/batRedirector.user.js
// ==/UserScript==

(() => {
  'use strict';
 //you can edit configs here (they might get overwritten on updates though so back them up pls!! smile)
  const RAW_BASE = 'https://raw.githubusercontent.com/TFBUtils/dependancies/batdirector/data/';
  const HANDLE_URL = RAW_BASE + 'channelHandle.txt';
  const ID_URL = RAW_BASE + 'channelID.txt';

  const PREFER_YOUTUBE_ID = true;
  const CACHE_MINUTES = 30;
  const SHOW_OVERLAY = true;
  const OVERLAY_TEXT = 'redirecting to channel\'s ID';
  const REWRITE_LINKS = true;
  const REWRITE_ALL_PAGES = true;
  const REWRITE_DELAY_MS = 150;
  const INTERCEPT_CLICKS = true;
  const SPA_NAVIGATE = true;
  const SPA_URL_SWAP = true;
  const LOOP_GUARD_MS = 15000;
 //easy configs end here, everything below this is super duper scary and advanced!!!
  const CACHE_MS = CACHE_MINUTES * 60 * 1000;
  const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
  const HANDLE_PATH_RE = /^\/@([^/]+)(\/.*)?$/;
  const log = (...a) => console.log('[batdirector]', ...a);

  function cacheRead(key) {
    if (CACHE_MS <= 0) return null;
    try {
      const raw = GM_getValue('cache:' + key, '');
      if (!raw) return null;
      const { t, v } = JSON.parse(raw);
      return { value: v, fresh: Date.now() - t < CACHE_MS };
    } catch (_) {
      return null;
    }
  }

  function cacheWrite(key, value) {
    if (CACHE_MS <= 0) return;
    try {
      GM_setValue('cache:' + key, JSON.stringify({ t: Date.now(), v: value }));
    } catch (_) {}
  }

  const memo = {};

  function gmGet(url) {
    if (memo[url]) return memo[url];

    const cached = cacheRead(url);
    if (cached && cached.fresh) {
      memo[url] = Promise.resolve(cached.value);
      return memo[url];
    }

    memo[url] = new Promise((resolve, reject) => {
      const fail = (err) => {
        if (cached) {
          log('using a stale cached copy of', url);
          resolve(cached.value);
        } else {
          reject(err);
        }
      };

      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (r) => {
          if (r.status >= 200 && r.status < 300) {
            const text = r.responseText.trim();
            cacheWrite(url, text);
            resolve(text);
          } else {
            fail(new Error(url + ' -> HTTP ' + r.status));
          }
        },
        onerror: () => fail(new Error('network error for ' + url)),
      });
    });

    memo[url].catch(() => delete memo[url]);
    return memo[url];
  }

  function parseLines(text) {
    return text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  let entriesPromise = null;

  function getEntries() {
    if (!entriesPromise) {
      entriesPromise = Promise.all([gmGet(HANDLE_URL), gmGet(ID_URL).catch(() => '')]).then(([handleText, idText]) => {
        const handles = parseLines(handleText);
        const ids = parseLines(idText);
        return handles.map((line, n) => ({
          handle: line.replace(/^@/, '').toLowerCase(),
          id: CHANNEL_ID_RE.test(ids[n] || '') ? ids[n] : null,
        }));
      });
      entriesPromise.catch(() => {
        entriesPromise = null;
      });
    }
    return entriesPromise;
  }

  async function findEntry(handle) {
    const entries = await getEntries();
    return entries.find((e) => e.handle === handle) || null;
  }

  function parseHandlePath(pathname) {
    const m = pathname.match(HANDLE_PATH_RE);
    if (!m) return null;
    let handle = m[1];
    try {
      handle = decodeURIComponent(handle);
    } catch (_) {}
    return { handle: handle.toLowerCase(), rest: m[2] || '' };
  }

  async function idFromYouTube(handle) {
    try {
      const res = await fetch('/@' + encodeURIComponent(handle), { credentials: 'same-origin' });
      const html = await res.text();
      const m =
        html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ||
        html.match(/"externalId":"(UC[\w-]{22})"/) ||
        html.match(/"channelId":"(UC[\w-]{22})"/);
      return m ? m[1] : null;
    } catch (e) {
      log('youtube ID lookup failed:', e);
      return null;
    }
  }

  async function resolveId(entry) {
    const cached = cacheRead('id:' + entry.handle);
    if (cached && cached.fresh && CHANNEL_ID_RE.test(cached.value)) return cached.value;

    const sources = PREFER_YOUTUBE_ID
      ? [() => idFromYouTube(entry.handle), () => entry.id]
      : [() => entry.id, () => idFromYouTube(entry.handle)];

    for (const get of sources) {
      const id = await get();
      if (id) {
        cacheWrite('id:' + entry.handle, id);
        return id;
      }
    }
    return null;
  }

  const idCache = new Map();

  function getId(entry) {
    if (!idCache.has(entry.handle)) {
      const p = resolveId(entry).then((id) => {
        if (!id) idCache.delete(entry.handle);
        return id;
      });
      idCache.set(entry.handle, p);
    }
    return idCache.get(entry.handle);
  }

  let overlay = null;
  let dotTimer = null;

  function showOverlay() {
    if (!SHOW_OVERLAY || overlay) return;

    const root = document.documentElement;
    const dark = root.hasAttribute('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;
    const fallbackBg = dark ? '#0f0f0f' : '#ffffff';
    const fallbackFg = dark ? '#ffffff' : '#0f0f0f';

    overlay = document.createElement('div');
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'font:500 20px/1 Roboto,Arial,sans-serif',
      `background:var(--yt-spec-base-background,${fallbackBg})`,
      `color:var(--yt-spec-text-primary,${fallbackFg})`,
    ].join(';');

    const label = document.createElement('span');
    label.textContent = OVERLAY_TEXT;

    const dots = document.createElement('span');
    dots.style.cssText = 'display:inline-block;width:1.2em;text-align:left';
    dots.textContent = '.';

    overlay.append(label, dots);
    root.appendChild(overlay);

    let count = 1;
    dotTimer = setInterval(() => {
      count = (count % 3) + 1;
      dots.textContent = '.'.repeat(count);
    }, 400);
  }

  function hideOverlay() {
    clearInterval(dotTimer);
    dotTimer = null;
    if (overlay) overlay.remove();
    overlay = null;
  }

  let running = false;

  function swapUrl(target) {
    try {
      const h = unsafeWindow.history;
      h.replaceState(h.state, '', target);
      return true;
    } catch (e) {
      log('url swap failed:', e);
      return false;
    }
  }

  async function swapSpaUrl(attempt) {
    const parsed = parseHandlePath(location.pathname);
    if (!parsed) return true;

    try {
      const entry = await findEntry(parsed.handle);
      if (!entry) return true;

      const id = await getId(entry);
      if (!id) return true;

      const now = parseHandlePath(location.pathname);
      if (!now || now.handle !== parsed.handle) return true;

      const target = `/channel/${id}${now.rest}${location.search}${location.hash}`;
      if (!swapUrl(target)) return false;
      log('swapped url to', target);

      if (attempt < 2) setTimeout(() => swapSpaUrl(attempt + 1), 600);
      return true;
    } catch (e) {
      log('error:', e);
      return true;
    }
  }

  async function check(fromSpa) {
    const parsed = parseHandlePath(location.pathname);
    if (!parsed) return;

    if (fromSpa) {
      if (!SPA_URL_SWAP) return;
      if (await swapSpaUrl(0)) return;
    }
    if (running) return;

    running = true;
    let redirecting = false;

    try {
      const entry = await findEntry(parsed.handle);
      if (!entry) return;

      const guardKey = 'batdirector-last:' + entry.handle;
      let recent = false;
      try {
        recent = Date.now() - Number(sessionStorage.getItem(guardKey) || 0) < LOOP_GUARD_MS;
      } catch (_) {}
      if (recent) {
        log('redirected recently, skipping because loops suck');
        return;
      }

      showOverlay();

      const id = await getId(entry);
      if (!id) {
        log('the handle matches, but no valid channel ID could be found');
        return;
      }

      try {
        sessionStorage.setItem(guardKey, String(Date.now()));
      } catch (_) {}

      const target = `https://www.youtube.com/channel/${id}${parsed.rest}${location.search}${location.hash}`;
      log('redirecting to', target);
      redirecting = true;
      location.replace(target);
    } catch (e) {
      log('error:', e);
    } finally {
      running = redirecting;
      if (!redirecting) hideOverlay();
    }
  }

  let queued = false;

  async function rewriteLinks() {
    queued = false;
    if (!REWRITE_LINKS || (!REWRITE_ALL_PAGES && location.pathname !== '/results')) return;

    try {
      const entries = await getEntries();
      if (!entries.length) return;
      const byHandle = new Map(entries.map((e) => [e.handle, e]));

      const matches = [];
      for (const a of document.querySelectorAll('a[href*="/@"]')) {
        if (!a.hostname.endsWith('youtube.com')) continue;
        const parsed = parseHandlePath(a.pathname);
        const entry = parsed && byHandle.get(parsed.handle);
        if (entry) matches.push([a, entry, parsed.rest]);
      }
      if (!matches.length) return;

      const ids = new Map();
      for (const [, entry] of matches) {
        if (!ids.has(entry)) ids.set(entry, await getId(entry));
      }

      for (const [a, entry, rest] of matches) {
        const id = ids.get(entry);
        if (!id) continue;
        a.href = `/channel/${id}${rest}${a.search}${a.hash}`;
        if (!rest) a.dataset.batdirector = entry.handle;
      }
    } catch (e) {
      log('link rewrite error:', e);
    }
  }

  function queueRewrite() {
    if (queued || !REWRITE_LINKS) return;
    if (!REWRITE_ALL_PAGES && location.pathname !== '/results') return;
    queued = true;
    setTimeout(rewriteLinks, REWRITE_DELAY_MS);
  }

  new MutationObserver(queueRewrite).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  function spaNavigate(id) {
    try {
      const page = unsafeWindow;
      const app = page.document.querySelector('ytd-app');
      if (!app || typeof app.fire !== 'function') return false;

      const detail = page.JSON.parse(
        JSON.stringify({
          endpoint: {
            commandMetadata: {
              webCommandMetadata: {
                url: `/channel/${id}`,
                webPageType: 'WEB_PAGE_TYPE_CHANNEL',
                rootVe: 3611,
                apiUrl: '/youtubei/v1/browse',
              },
            },
            browseEndpoint: { browseId: id },
          },
        })
      );

      app.fire('yt-navigate', detail);
      return true;
    } catch (e) {
      log('spa navigation failed:', e);
      return false;
    }
  }

  function trySpaClick(href) {
    const m = new URL(href, location.origin).pathname.match(/^\/channel\/(UC[\w-]{22})\/?$/);
    if (!m) return false;

    const from = location.href;
    if (!spaNavigate(m[1])) return false;

    setTimeout(() => {
      if (location.href !== from) return;
      log('spa navigation didnt work, falling back to a direct url load (which will reload the page :D)');
      showOverlay();
      location.assign(href);
    }, 3000);

    return true;
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!INTERCEPT_CLICKS || e.defaultPrevented || e.button !== 0) return;
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;

      const link = e.composedPath().find((n) => n.tagName === 'A' && n.dataset && n.dataset.batdirector);
      if (!link) return;

      e.preventDefault();
      e.stopImmediatePropagation();
      if (SPA_NAVIGATE && trySpaClick(link.href)) return;

      showOverlay();
      location.assign(link.href);
    },
    true
  );

  const onSpaNavigate = () => {
    check(true);
    queueRewrite();
  };

  check(false);
  queueRewrite();
  window.addEventListener('yt-navigate-finish', onSpaNavigate);
  window.addEventListener('yt-page-data-updated', onSpaNavigate, true);
  window.addEventListener('popstate', onSpaNavigate);
})();
