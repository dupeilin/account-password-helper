/**
 * 录制 README 首屏的「一键登录」演示动图（中英各一套）。
 *
 *   node record.mjs <path-to-.output/chrome-mv3> [zh|en]
 *
 * 输出：中文 `docs/demo-login.webp` + `docs/demo-login.gif`，
 * 英文 `docs/demo-login-en.webp`。旧的真机录屏含真实账号画面，已退役；
 * 这里全部走 `demo-login.html` 占位演示页（`example.com` 数据），不含任何真实凭据。
 *
 * 前置与 `capture.mjs` 相同：Chrome 带 `--remote-debugging-port=9333` 启动、
 * `demo-server.mjs` 在跑、**且已按同一语言 seed**（见同目录 README.md）。
 * 中英两套必须各用一个全新 profile 分别 seed，否则英文动图里会出现中文标签。
 *
 * 为什么是关键帧而不是逐帧录屏：页面级 CDP 截图抓不到系统指针，而侧边栏作为标签页
 * 处于后台时不产出动画帧，逐帧录屏拿不到它。这里按真实操作的**结果状态**逐帧截取，
 * 点击落点由合成阶段叠加的光标表示（坐标取自被点元素的 getBoundingClientRect）。
 *
 * 四个关键帧都是扩展自己的真实链路，脚本不代填任何字段：
 * 1. 空白登录页 + 侧边栏命中本站的 3 个账号；
 * 2. 光标悬停在条目的「填充并登录」图标上；
 * 3. 点击之后：扩展填好账号密码、自动勾选协议、自动点击登录，页面进入「Signing in...」；
 * 4. 站点受理完成，页面显示「Signed in」。
 * 第 3、4 帧是整幅页面而不是「网页 + 侧边栏」双栏——**填充成功后产品会自己收起侧边栏**
 * （FormDetector 在填充成功 300ms 后发 HIDE_SIDEPANEL），双栏构图到那里就散了。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BAND,
  BODY,
  LEFT_W,
  PANEL_W,
  W,
  attachTo,
  closeStaleDemoTabs,
  closeTab,
  compose,
  evalIn,
  grab,
  initExtension,
  metrics,
  newTab,
  openPanelScopedTo,
  wait,
  warmFavicons,
} from './shot.mjs';
import { COPY } from './copy.mjs';
import { DEMO_HOSTS, HOST_ADMIN, pageUrl } from './demo-hosts.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(HERE, '../../docs');

const EXT_DIR = process.argv[2];
const LANG = process.argv[3] || 'zh';
if (!EXT_DIR || !['zh', 'en'].includes(LANG)) {
  console.error('usage: node record.mjs <path-to-.output/chrome-mv3> [zh|en]');
  process.exit(1);
}

/** 输出尺寸：webp 给 README 首屏，gif 给引用 `.gif` 路径的推广文档。 */
const WEBP_SIZE = '1152:720';
const GIF_SIZE = '900:-2';
/** 各关键帧停留时长（秒），一轮约 7s。 */
const HOLDS = { idle: 1.4, hover: 1.2, pending: 2, done: 2.4 };
/** 演示条目与「填充并登录」图标（每条都渲染，除非偏好里开了「自动触发登录」）。 */
const DEMO_USER = 'demo-admin@example.com';
const FILL_AND_LOGIN = '.auto-login-icon';

const C = COPY[LANG];
const suffix = LANG === 'en' ? '-en' : '';

/**
 * 定位本站条目上的动作图标，回传矩形中心；`doClick` 为真时才真正点击。
 *
 * 悬停帧与点击帧共用同一份查找逻辑，保证光标画在实际被点的元素上。
 */
const entryAction = (sel, doClick) => `(() => {
  const isVisible = (n) => !!(n.offsetWidth || n.offsetHeight || n.getClientRects().length);
  const items = [...document.querySelectorAll('.password-item')].filter(isVisible);
  const item = items.find((n) => (n.textContent || '').includes(${JSON.stringify(DEMO_USER)}));
  if (!item) {
    return JSON.stringify({ error: 'entry not found: ${DEMO_USER} (visible ' + items.length + ' items)' });
  }
  const target = item.querySelector(${JSON.stringify(sel)});
  if (!target) return JSON.stringify({ error: 'action not found: ' + ${JSON.stringify(sel)} });
  const r = target.getBoundingClientRect();
  ${doClick ? 'target.click();' : ''}
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
})()`;

/** 演示页登录按钮矩形中心：扩展的 triggerLogin 点的就是它。 */
const LOGIN_BUTTON_RECT = `(() => {
  const b = document.querySelector('.card button[type=submit]');
  if (!b) return '';
  const r = b.getBoundingClientRect();
  return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
})()`;

/**
 * 回读演示页状态，用于断言「是扩展填的、不是脚本填的」。
 *
 * 密码只回传长度：占位数据虽非真实凭据，但按项目基线，密码明文不进日志。
 */
const PAGE_STATE = `JSON.stringify({
  email: document.getElementById('email').value,
  passwordChars: document.getElementById('password').value.length,
  remember: document.getElementById('remember').checked,
  status: document.getElementById('status').hidden ? '' : document.getElementById('status').textContent,
})`;

/**
 * 轮询演示页的登录状态，直到命中条件或超时。
 *
 * 不能只靠固定延时：从点击到「受理中」取决于扩展的填充节奏（约 0.4s），
 * 而 CDP 往返抖动可达数百毫秒，取早了会拍到还没填充的表单。
 */
async function waitForStatus(s, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    last = JSON.parse(await evalIn(s, PAGE_STATE)).status;
    if (pred(last)) return last;
    await wait(150);
  }
  throw new Error(`登录状态未出现（最后为「${last || '空'}」），检查填充是否成功、?demo=status 是否生效`);
}

/** 侧边栏矩形（380 宽视口坐标）→ 双栏合成画布逻辑坐标。 */
const panelPoint = r => ({ x: LEFT_W + r.x, y: BAND + r.y });
/** 网页矩形（视口坐标）→ 合成画布逻辑坐标（标题带之下，故纵坐标加 BAND）。 */
const pagePoint = r => ({ x: r.x, y: BAND + r.y });

/** 演示站点：条目按精确域名匹配，侧边栏只会列出该站点的 3 个账号。 */
const DEMO_URL = `${pageUrl(HOST_ADMIN, 'demo-login.html')}?demo=status`;

await initExtension(EXT_DIR);
await closeStaleDemoTabs();
// 侧边栏条目的网站图标来自浏览器本地缓存，没预热过的域名只会是通用地球图标。
await warmFavicons(DEMO_HOSTS);

const tab = await newTab(DEMO_URL);
await wait(1800);
const { s: page } = await attachTo(t => t.id === tab.id);
await metrics(page, LEFT_W, BODY);

const { s: panel, panelId } = await openPanelScopedTo(tab.id);
await metrics(panel, PANEL_W, BODY);

const entryCount = await evalIn(panel, `document.querySelectorAll('.password-item').length`);
if (!entryCount) {
  throw new Error(
    '侧边栏没有条目：请先用同一语言跑 seed.mjs，' +
      '且确认扩展会话未失效（失效时侧边栏显示「去验证主密码」而不是列表）',
  );
}
console.log(`侧边栏条目数: ${entryCount}（界面语言 ${LANG}）`);

const frameDir = resolve(tmpdir(), `aph-store-demo-frames-${LANG}`);
mkdirSync(frameDir, { recursive: true });
const frames = [];

/** 抓一帧并合成 2560×1600 帧图；`full` 为真时只铺网页（侧边栏已收起）。 */
async function captureFrame(name, cursor, full = false) {
  const file = join(frameDir, `frame-${String(frames.length + 1).padStart(2, '0')}.png`);
  const panes = full
    ? [{ buf: await grab(page), width: W }]
    : [
        { buf: await grab(page), width: LEFT_W },
        { buf: await grab(panel), width: PANEL_W },
      ];
  await compose(C.login, panes, file, { cursor, quiet: true });
  frames.push({ file, hold: HOLDS[name] });
  console.log(`frame ${frames.length}: ${name} (${HOLDS[name]}s)`);
}

/**
 * 把指针挪到页面左上角的空白处。
 *
 * 侧边栏收起后网页变宽，页内悬浮按钮正好落到系统指针下面并弹出提示气泡；指针位置
 * 不受脚本控制，不主动避开的话每次重录出来的帧内容都不一样。
 */
async function parkCursor(s) {
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 4, y: 4 });
}

// ---- 帧 1 / 2：空白表单 + 侧边栏列表，光标落到「填充并登录」图标上 ----
await captureFrame('idle');
const hover = JSON.parse(await evalIn(panel, entryAction(FILL_AND_LOGIN, false)));
if (hover.error) throw new Error(hover.error);
await captureFrame('hover', panelPoint(hover));

// ---- 点击：填充 → 自动勾选协议 → 自动点击登录（全部由扩展完成）----
const clicked = JSON.parse(await evalIn(panel, entryAction(FILL_AND_LOGIN, true)));
if (clicked.error) throw new Error(clicked.error);
// 填充成功后产品会自己收起侧边栏，这里等它收完再改回整幅构图
const pending = await waitForStatus(page, s => s.startsWith('Signing'), 8000);
console.log('page after click:', pending, '| state:', await evalIn(page, PAGE_STATE));
await closeTab(panelId);
await metrics(page, W, BODY);
await parkCursor(page);

const button = await evalIn(page, LOGIN_BUTTON_RECT);
const cursorOnLogin = button ? { ...pagePoint(JSON.parse(button)), pressed: true } : undefined;
await captureFrame('pending', cursorOnLogin, true);

// ---- 帧 4：站点受理完成 ----
const done = await waitForStatus(page, s => s.startsWith('Signed'), 8000);
console.log('page after submit:', done);
await parkCursor(page);
await captureFrame('done', cursorOnLogin, true);

page.close();
panel.close();
await closeTab(tab.id);

// ---- 编码为动画 webp（README 首屏）与 gif（推广文档引用 .gif 路径）----
const list = join(frameDir, 'frames.txt');
writeFileSync(
  list,
  frames.map(f => `file '${f.file}'\nduration ${f.hold}`).join('\n') + `\nfile '${frames[frames.length - 1].file}'\n`,
);

const targets = [{ out: join(DOCS_DIR, `demo-login${suffix}.webp`), size: WEBP_SIZE, kind: 'webp' }];
if (LANG === 'zh') targets.push({ out: join(DOCS_DIR, 'demo-login.gif'), size: GIF_SIZE, kind: 'gif' });

for (const t of targets) {
  const common = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list];
  const vf = `scale=${t.size}:flags=lanczos`;
  const args =
    t.kind === 'webp'
      ? [
          ...common,
          '-vf',
          vf,
          '-fps_mode',
          'passthrough',
          '-c:v',
          'libwebp',
          '-preset',
          'picture',
          '-quality',
          '72',
          '-loop',
          '0',
          t.out,
        ]
      : [
          ...common,
          '-filter_complex',
          `[0:v]${vf},split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4[o]`,
          '-map',
          '[o]',
          '-fps_mode',
          'passthrough',
          '-loop',
          '0',
          t.out,
        ];
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(`ffmpeg ${t.kind} 编码失败:\n${r.stderr}`);
    console.error(`关键帧与清单在 ${frameDir}，可原样重跑：\n  ffmpeg ${args.join(' ')}`);
    process.exit(1);
  }
  console.log(`wrote ${t.out} (${(statSync(t.out).size / 1024).toFixed(0)} KB)`);
}
