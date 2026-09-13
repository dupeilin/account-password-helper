/**
 * 截取并合成商店截图（中英各一套）。
 *
 *   node capture.mjs <extDir> seeded  [zh|en]   # 一键登录 / TOTP / 多环境 / 安全体检
 *   node capture.mjs <extDir> prefs   [zh|en]   # 偏好设置（主题 / 双语切换）
 *   node capture.mjs <extDir> firstrun [zh|en]  # 本地加密（首启设置主密码页）
 *
 * 前置：Chrome 带 --remote-debugging-port=9333 启动、扩展已加载、demo-server.mjs
 * 在跑（本地 HTTPS 演示站），且已按对应语言 seed（英文页需要英文占位标签，必须换
 * 全新 profile 重新 seed）。详见同目录 README.md。输出写入 <repo>/assets/cws-store/，
 * 英文版文件名带 -en 后缀。
 *
 * Dashboard 上中文页与 English (United States) 页的截图槽位互相独立，两套都要上传。
 * 标题带文案与商店四个字段同口径：零竞品品牌名、零绝对化表述。
 */
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BODY,
  LEFT_W,
  PANEL_W,
  W,
  attachTo,
  closeTab,
  compose,
  evalIn,
  extUrl,
  grab,
  initExtension,
  metrics,
  newTab,
  warmFavicons,
} from './shot.mjs';
import { DEMO_HOSTS, HOST_ADMIN, HOST_CONSOLE, pageUrl } from './demo-hosts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(HERE, '../../assets/cws-store');

// 演示页地址与域名清单见 `demo-hosts.mjs`：必须用**域名**访问而不是 127.0.0.1
// （扩展条目按精确域名匹配），且必须是 `https://<host>` 这种不带端口的形态，
// favicon 缓存才会与条目网址对得上。

const EXT_DIR = process.argv[2];
const MODE = process.argv[3];
if (!EXT_DIR || !['seeded', 'prefs', 'firstrun'].includes(MODE)) {
  console.error('usage: node capture.mjs <path-to-.output/chrome-mv3> <seeded|prefs|firstrun> [zh|en]');
  process.exit(1);
}

const LANG = process.argv[4] || 'zh';
if (!['zh', 'en'].includes(LANG)) {
  console.error('lang must be zh or en');
  process.exit(1);
}

/** 标题带文案（中英各一份）。 */
const COPY = {
  zh: {
    suffix: '',
    login: {
      title: '一键登录：填充 → 勾选「记住我」→ 自动点击登录',
      sub: '侧边栏「填充并登录」，或在偏好设置中开启「自动触发登录」',
    },
    totp: {
      title: 'TOTP 两步验证：验证码和密码住在一起，不用摸手机',
      sub: '扫码或上传图片即可添加密钥，动态码在本机按 RFC 6238 生成',
    },
    audit: {
      title: '离线安全体检：0-100 分给密码健康打分，全程本机计算',
      sub: '复用 / 弱密码 / 常见泄露 / 长期未更新四维加权，不联网',
    },
    env: {
      title: '多环境账号管理：同一站点，开发 / 测试 / 生产分得清清楚楚',
      sub: '条目按精确域名匹配，各环境凭据互不混淆',
    },
    favorites: {
      title: '收藏常用账号：星标置顶，再一键只看收藏',
      sub: '侧边栏与密码列表各有一个星标开关，标签按名称稳定配色',
    },
    detail: {
      title: '条目详情：备注、两步验证活码、修改历史一屏看全',
      sub: '密码默认掩码，点眼睛才显示；复制后按设置自动清除剪贴板',
    },
    inline: {
      title: '页内填充面板：在输入框旁边直接挑账号',
      sub: '快捷键 Cmd/Ctrl+Shift+K 展开，带网站图标、标签与收藏标识',
    },
    prefs: {
      title: '6 款主题 + 中英文双语界面，即时切换无需刷新',
      sub: '扩展页与注入页面的浮层同步生效，快捷键均可在浏览器页自定义',
    },
    encryption: {
      title: '本地加密：密码只存在你的浏览器里，加密后落盘',
      sub: 'PBKDF2 600,000 次迭代 + AES-256-GCM，密码数据不上传服务器',
    },
  },
  en: {
    suffix: '-en',
    login: {
      title: 'One-click login: fill, tick consent, click Sign in',
      sub: 'Use Fill and sign in in the side panel, or enable auto-submit in preferences',
    },
    totp: {
      title: 'TOTP two-factor: codes live right next to the passwords',
      sub: 'Add a key by scanning a QR code or uploading an image; codes are generated on your device per RFC 6238',
    },
    audit: {
      title: 'Offline security audit: a 0-100 score for password health',
      sub: 'Weighted across reuse, weakness, common leaks and staleness; all computed on your device',
    },
    env: {
      title: 'Multi-environment accounts: dev, test and prod kept apart',
      sub: 'Entries match the exact host name, so credentials never mix between environments',
    },
    favorites: {
      title: 'Star the accounts you use, then filter to favorites',
      sub: 'One star toggle in the side panel and one in the list; each tag keeps its own color',
    },
    detail: {
      title: 'Entry details: notes, live codes and change history in one panel',
      sub: 'Passwords stay masked until you click the eye; copies clear from the clipboard on a timer',
    },
    inline: {
      title: 'In-page fill panel: pick an account right beside the field',
      sub: 'Open it with Cmd/Ctrl+Shift+K, with site icons, tags and favorite marks',
    },
    prefs: {
      title: '6 color themes plus an English/Chinese UI, switched instantly',
      sub: 'Applies to extension pages and injected overlays; every shortcut is customizable',
    },
    encryption: {
      title: 'Encrypted locally: passwords stay in your browser, encrypted at rest',
      sub: 'PBKDF2 with 600,000 iterations plus AES-256-GCM; password data is never uploaded',
    },
  },
};

/** 管理页上的入口文案（按界面语言不同）。 */
const UI = {
  zh: { audit: '安全体检', prefs: '偏好设置', detail: '查看详情' },
  en: { audit: 'Health Check', prefs: 'Preferences', detail: 'View details' },
};

const C = COPY[LANG];
const out = name => resolve(OUT_DIR, name.replace(/\.png$/, `${C.suffix}.png`));

// 逻辑视口比目标宽一点，避免宽表格被裁切；像素尺寸由 compose() 归一。
const RW = 1440;
const RH = Math.round(BODY / (1280 / RW));

const wait = ms => new Promise(r => setTimeout(r, ms));

/**
 * 把扩展界面语言切到目标语言。
 *
 * 与偏好设置面板里的「中文 / English」开关等效：同时写 localStorage 同步镜像
 * （扩展页同源共享，见 utils/i18n/index.ts）与 chrome.storage.local 持久值，
 * 重载页面即可让整套 UI 变成目标语言。
 */
async function applyLocale(s) {
  const locale = LANG === 'en' ? 'en' : 'zh-CN';
  await evalIn(
    s,
    `(async () => {
      localStorage.setItem('app_locale', ${JSON.stringify(locale)});
      await chrome.storage.local.set({ app_locale: ${JSON.stringify(locale)} });
      return 'locale set';
    })()`,
  );
  await s.send('Page.reload', { ignoreCache: true });
  await wait(3500);
}

/**
 * 会话失效时解锁管理页。
 *
 * 用结构判定而不是文案匹配（中英文提示语不同）：有主密码输入框且列表为空即视为锁定，
 * 提交按钮取 Element Plus 的主按钮。
 */
async function unlockIfNeeded(s) {
  const locked = await evalIn(
    s,
    `document.querySelectorAll('.el-table__row').length === 0 && !!document.querySelector('input[type=password]')`,
  );
  if (!locked) return;
  await evalIn(
    s,
    `(() => {
      const el = document.querySelector('input[type=password]');
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
      d.set.call(el, 'Demo!Pass2026');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      const b = [...document.querySelectorAll('button')].find((x) =>
        x.classList.contains('el-button--primary')
      );
      if (b) b.click();
      return 'submitted';
    })()`,
  );
  await wait(4000);
}

/**
 * 点击含指定文案的入口。
 *
 * 管理页的「导入数据」「偏好设置」是卡片（div）而非 button，所以先找叶子节点再向上
 * 回溯到可点击祖先；「安全体检」按钮里除文字外还有个状态圆点，精确匹配会落空，
 * 因此再兜一层「按钮文案包含该词」。隐藏的下拉菜单项也会命中，故优先取可见节点。
 */
async function clickByLabel(s, label) {
  return evalIn(
    s,
    `(() => {
      const wanted = ${JSON.stringify(label)};
      const isVisible = (n) =>
        !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length);

      const leaves = [...document.querySelectorAll('body *')].filter(
        (n) => n.children.length === 0 && (n.textContent || '').trim() === wanted
      );
      const leaf = leaves.find(isVisible) || leaves[0];
      if (leaf) {
        let el = leaf;
        while (
          el &&
          el !== document.body &&
          el.tagName !== 'BUTTON' &&
          el.tagName !== 'A'
        ) {
          el = el.parentElement;
        }
        const target = el && el !== document.body ? el : leaf;
        target.click();
        return 'clicked leaf ancestor ' + target.tagName;
      }

      const btns = [...document.querySelectorAll('button')].filter((x) =>
        (x.innerText || '').includes(wanted)
      );
      const b = btns.find(isVisible) || btns[0];
      if (!b) return 'label not found: ' + wanted;
      b.click();
      return 'clicked button';
    })()`,
  );
}

/**
 * 点击侧边栏搜索行里的第 idx 个圆形按钮（0=搜索范围，1=只看收藏，2=排序）。
 *
 * 只有搜索范围按钮带 aria-label，另两个只挂在 tooltip 上，因此按结构取；
 * 回读 class 里的 `el-button--*` 供日志确认状态是否切换（只看收藏激活后会变 warning）。
 */
const clickSearchSection = idx => `(() => {
  const btns = [...document.querySelectorAll('.search-section button')];
  const b = btns[${idx}];
  if (!b) return 'button not found (' + btns.length + ' in row)';
  b.click();
  return 'clicked ' + [...b.classList].filter((c) => c.startsWith('el-button--')).join(' ');
})()`;

/** 详情抽屉入口按钮选择器（按界面语言取 aria-label）。 */
const detailSel = `button[aria-label=${JSON.stringify(UI[LANG].detail)}]`;

/** 打开侧边栏页面、把 active tab 切回目标页，再 reload 侧边栏，使其命中该站点账号。 */
async function openPanelScopedTo(tabId) {
  const panel = await newTab(extUrl('sidepanel.html'));
  await wait(1200);
  const { s: ts } = await attachTo(t => t.id === tabId);
  await ts.send('Target.activateTarget', { targetId: tabId }).catch(() => {});
  ts.close();
  await wait(500);
  const { s: ps } = await attachTo(t => t.id === panel.id);
  await ps.send('Page.reload', { ignoreCache: true });
  await wait(4000);
  return { s: ps, panelId: panel.id };
}

/** 打开一个「网页 + 侧边栏」的并排截图；onPanel 用于在截图前操作侧边栏。 */
async function capturePagePlusPanel(url, ctx, fileName, onPanel) {
  const tab = await newTab(url);
  await wait(1500);
  const { s: page } = await attachTo(t => t.id === tab.id);
  await metrics(page, LEFT_W, BODY);
  const pageBuf = await grab(page);
  const { s: panel, panelId } = await openPanelScopedTo(tab.id);
  if (onPanel) await onPanel(panel);
  await metrics(panel, PANEL_W, BODY);
  const panelBuf = await grab(panel);
  await compose(
    ctx,
    [
      { buf: pageBuf, width: LEFT_W },
      { buf: panelBuf, width: PANEL_W },
    ],
    out(fileName),
  );
  page.close();
  panel.close();
  await closeTab(tab.id);
  await closeTab(panelId);
}

/** 只拍网页（整屏 1280 宽），用于页内注入 UI 的截图。 */
async function capturePageOnly(url, ctx, fileName, onReady) {
  const tab = await newTab(url);
  await wait(1800);
  const { s: page } = await attachTo(t => t.id === tab.id);
  await metrics(page, W, BODY);
  if (onReady) await onReady(page, tab);
  await compose(ctx, [{ buf: await grab(page), width: W }], out(fileName));
  page.close();
  await closeTab(tab.id);
}

/** 只拍管理页（整屏 1280 宽），先确保已解锁并切到目标语言。 */
async function captureOptions(ctx, fileName, onReady) {
  const tab = await newTab(extUrl('options.html'));
  const { s } = await attachTo(t => t.id === tab.id);
  await metrics(s, RW, RH);
  await wait(2500);
  await unlockIfNeeded(s);
  await applyLocale(s);
  if (onReady) await onReady(s);
  await compose(ctx, [{ buf: await grab(s), width: 1280 }], out(fileName));
  s.close();
  await closeTab(tab.id);
}

await initExtension(EXT_DIR);

if (MODE === 'seeded') {
  // 条目列表与侧边栏都要展示网站图标，先把演示域名的 favicon 灌进浏览器本地缓存
  await warmFavicons(DEMO_HOSTS);

  // ---- 一键登录：演示登录页已填充 + 侧边栏命中该站点账号 ----
  const loginTab = await newTab(pageUrl(HOST_ADMIN, 'demo-login.html'));
  await wait(1500);
  const { s: ls } = await attachTo(t => t.id === loginTab.id);
  await metrics(ls, LEFT_W, BODY);
  await evalIn(
    ls,
    `(() => {
      const set = (id, v) => {
        const el = document.getElementById(id);
        const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
        d.set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      };
      set('email', 'demo-admin@example.com');
      set('password', 'Demo!Prod2026x');
      const cb = document.getElementById('remember');
      if (!cb.checked) cb.click();
      return 'filled';
    })()`,
  );
  await wait(600);
  const loginBuf = await grab(ls);
  const { s: panel1, panelId } = await openPanelScopedTo(loginTab.id);
  await metrics(panel1, PANEL_W, BODY);
  const panel1Buf = await grab(panel1);
  await compose(
    { title: C.login.title, sub: C.login.sub },
    [
      { buf: loginBuf, width: LEFT_W },
      { buf: panel1Buf, width: PANEL_W },
    ],
    out('screen-1-one-click-login.png'),
  );
  ls.close();
  panel1.close();
  await closeTab(loginTab.id);
  await closeTab(panelId);

  // ---- TOTP 两步验证 ----
  await capturePagePlusPanel(
    pageUrl(HOST_CONSOLE, 'demo-2fa.html'),
    { title: C.totp.title, sub: C.totp.sub },
    'screen-2-totp.png',
  );

  // ---- 多环境账号 / 安全体检：同一管理页的两个状态 ----
  const optTab = await newTab(extUrl('options.html'));
  const { s: os } = await attachTo(t => t.id === optTab.id);
  await metrics(os, RW, RH);
  await wait(2500);
  await unlockIfNeeded(os);
  await applyLocale(os);

  await compose(
    { title: C.env.title, sub: C.env.sub },
    [{ buf: await grab(os), width: 1280 }],
    out('screen-3-multi-env.png'),
  );

  console.log('audit entry:', await clickByLabel(os, UI[LANG].audit));
  await wait(3500);
  await compose(
    { title: C.audit.title, sub: C.audit.sub },
    [{ buf: await grab(os), width: 1280 }],
    out('screen-4-security-audit.png'),
  );
  os.close();
  await closeTab(optTab.id);

  // ---- 收藏置顶 + 只看收藏：切到全站视图，收藏的账号分属不同站点 ----
  await capturePagePlusPanel(
    pageUrl(HOST_ADMIN, 'demo-login.html'),
    { title: C.favorites.title, sub: C.favorites.sub },
    'screen-7-favorites.png',
    async panel => {
      console.log('scope:', await evalIn(panel, clickSearchSection(0)));
      await wait(1500);
      console.log('favorites:', await evalIn(panel, clickSearchSection(1)));
      await wait(1500);
    },
  );

  // ---- 条目详情抽屉：ops 那条同时带活码与多标签，展示字段最全 ----
  await captureOptions({ title: C.detail.title, sub: C.detail.sub }, 'screen-8-detail-drawer.png', async s => {
    console.log(
      'drawer:',
      await evalIn(
        s,
        `(() => {
            const rows = [...document.querySelectorAll('.el-table__row')];
            const row = rows.find((r) => (r.textContent || '').includes('ops@example.com')) || rows[0];
            const btn = row && row.querySelector(${JSON.stringify(detailSel)});
            if (!btn) return 'detail button not found';
            btn.click();
            return 'opened';
          })()`,
      ),
    );
    await wait(2000);
  });

  // ---- 页内填充面板：内容脚本只收扩展页的 tabs.sendMessage，借管理页当发起方 ----
  await capturePageOnly(
    pageUrl(HOST_ADMIN, 'demo-login.html'),
    { title: C.inline.title, sub: C.inline.sub },
    'screen-9-inline-fill.png',
    async (page, tab) => {
      await evalIn(page, `document.getElementById('email')?.focus()`);
      const ext = await newTab(extUrl('options.html'));
      await wait(2000);
      const { s: es } = await attachTo(t => t.id === ext.id);
      console.log(
        'inline dropdown:',
        await evalIn(
          es,
          `(async () => {
            // CDP targetId 不是 chrome.tabs 的整数 id，只能按 URL 反查
            const [target] = await chrome.tabs.query({ url: ${JSON.stringify(tab.url)} });
            if (!target) return 'demo tab not found: ' + ${JSON.stringify(tab.url)};
            try {
              const res = await chrome.tabs.sendMessage(target.id, { type: 'OPEN_INLINE_DROPDOWN', data: {} });
              return 'tab ' + target.id + ' -> ' + JSON.stringify(res);
            } catch (e) {
              return 'tab ' + target.id + ' sendMessage failed: ' + e.message;
            }
          })()`,
        ),
      );
      es.close();
      await closeTab(ext.id);
      await wait(1500);
    },
  );
} else if (MODE === 'prefs') {
  // ---- 偏好设置：主题换肤 + 双语切换（需先 seed，管理页处于已解锁状态）----
  const t = await newTab(extUrl('options.html'));
  const { s } = await attachTo(x => x.id === t.id);
  await metrics(s, RW, RH);
  await wait(2500);
  await unlockIfNeeded(s);
  await applyLocale(s);
  console.log('prefs entry:', await clickByLabel(s, UI[LANG].prefs));
  await wait(3000);
  await compose(
    { title: C.prefs.title, sub: C.prefs.sub },
    [{ buf: await grab(s), width: 1280 }],
    out('screen-5-preferences.png'),
  );
  s.close();
  await closeTab(t.id);
} else {
  // ---- 本地加密：全新 profile 的首启「设置主密码」页（含安全声明）----
  const t = await newTab(extUrl('options.html'));
  const { s } = await attachTo(x => x.id === t.id);
  await metrics(s, RW, RH);
  await wait(3000);
  await applyLocale(s);
  // 两个密码框都填上，校验通过且强度清单呈现实时状态
  await evalIn(
    s,
    `(() => {
      const els = [...document.querySelectorAll('input[type=password]')];
      if (els.length < 2) return 'not first-run';
      const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(els[0]), 'value');
      for (const el of els) {
        d.set.call(el, 'Demo!Pass2026');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      els[0].focus();
      return 'typed ' + els.length;
    })()`,
  );
  await wait(1500);
  await compose(
    { title: C.encryption.title, sub: C.encryption.sub },
    [{ buf: await grab(s), width: 1280 }],
    out('screen-6-local-encryption.png'),
  );
  s.close();
  await closeTab(t.id);
}
