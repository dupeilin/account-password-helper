# 商店截图流水线（store-shots）

用脚本生成 Chrome 应用商店的产品截图，**中英各一套、每套 9 张**，输出到
`assets/cws-store/screen-*.png`（2560×1600 = 1280×800 @2x）。

Dashboard 里中文页与 English (United States) 页的截图槽位**互相独立、不会继承**，
所以两套都要上传；英文版文件名带 `-en` 后缀。

## 为什么是脚本化截图，而不是真机截屏

- macOS 的窗口级截屏（`screencapture -l`）需要「屏幕录制」权限，沙箱/CI 拿不到；
- 真机截图会把作者的真实账号、真实邮箱带进商店素材；
- 商店文案受关键字堆砌政策约束，**图片里的文字同属商店元数据**，脚本里的标题带文案可以随文案定稿一起 review 和复跑。

流程是：CDP 驱动本地 Chrome → 加载解压扩展 → 注入占位演示数据 → 页面级截图 →
用 `sharp` 合成品牌标题带。占位数据全部是 `example.com`，不含任何真实凭据。

## 前置

```bash
pnpm install          # 需要 sharp（已是项目依赖）
pnpm build            # 截图里的版本徽章取自构建产物的 manifest.version
```

构建后**确认版本号与即将提交商店的包一致**，否则又会出现「截图版本与商店版本不符」。

## 复现步骤

Chrome 137+ 已不再支持 `--load-extension`，因此扩展改由 CDP 的
`Extensions.loadUnpacked` 动态加载，需要 `--enable-unsafe-extension-debugging`。

```bash
cd <repo>

# 1) 起演示站（本地 HTTPS，按域名合成 favicon；证书自签名、落在系统临时目录）
node scripts/store-shots/demo-server.mjs &

# 2) 启动 Chrome：演示域名映射到本地 HTTPS 端口，关掉代理（否则会 502），
#    并放开后台标签的节流/遮挡降频（截图时侧边栏必须待在后台标签里）
PROFILE="$(mktemp -d)"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --user-data-dir="$PROFILE" --remote-debugging-port=9333 \
  --enable-unsafe-extension-debugging --no-first-run --no-default-browser-check \
  --no-proxy-server --window-size=1440,805 \
  --ignore-certificate-errors \
  --host-resolver-rules="MAP *.example.com 127.0.0.1:8443" \
  --disable-backgrounding-occluded-windows --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  about:blank &
```

然后按**语言**跑三批。每批的 `seeded` / `prefs` 用同一个 profile，`firstrun` 必须换
**全新 profile**（图 6 需要「还没设主密码」的首启状态）：

```bash
# —— 中文页 ——
node scripts/store-shots/seed.mjs    "$PWD/.output/chrome-mv3" zh   # 首次运行会设主密码 + 导入 10 条 + 收藏 2 条 + 轮换 1 条密码
node scripts/store-shots/capture.mjs "$PWD/.output/chrome-mv3" seeded    zh
node scripts/store-shots/capture.mjs "$PWD/.output/chrome-mv3" prefs     zh
# 换全新 profile 重新起 Chrome，再跑：
node scripts/store-shots/capture.mjs "$PWD/.output/chrome-mv3" firstrun  zh

# —— 英文页 ——（英文的标签/备注与中文不同，必须换全新 profile 重新 seed）
node scripts/store-shots/seed.mjs    "$PWD/.output/chrome-mv3" en
node scripts/store-shots/capture.mjs "$PWD/.output/chrome-mv3" seeded    en
node scripts/store-shots/capture.mjs "$PWD/.output/chrome-mv3" prefs     en
node scripts/store-shots/capture.mjs "$PWD/.output/chrome-mv3" firstrun  en
```

> ⚠️ 演示页必须用**域名**访问（`admin.example.com` / `console.example.com`）而不是
> `127.0.0.1`：条目按精确域名匹配，用 IP 打开侧边栏会退化成「列出全部条目」，
> 失去「命中该站点账号」的演示效果。
>
> ⚠️ 访问地址的 scheme + host 必须和条目网址一致：Chrome 的 favicon 缓存按
> `CanonicizeURL`（清掉 path/query，但**保留 scheme 与 port**）建索引，条目写
> `https://admin.example.com` 而页面用 `http://…:8777` 打开，图标就命中不了缓存，
> 截图里只剩通用地球图标。这也是演示站走 HTTPS、端口只由 `--host-resolver-rules`
> 在解析层替换（地址栏保持干净的 `https://<host>`）的原因。
>
> 域名清单集中在 `demo-hosts.mjs`（seed 的条目网址、capture 的访问地址、预热清单
> 共用一份）；`SHOT_PORT` 只改 `demo-server.mjs` 的监听端口，改了要同步改
> `--host-resolver-rules`。

## 九张图的卖点与标题带文案

标题带文案的合规约束与商店四个字段完全一致：**零竞品品牌名、零绝对化表述**
（不得写「零联网 / 100% offline / 数据不出浏览器」——扩展每 6 小时有一次
不携带用户数据的匿名版本检查）。改文案后重跑 `capture.mjs` 即可，文案表在
`capture.mjs` 的 `COPY` 常量里（中英各一份）。

| 文件（英文加 `-en`）            | 卖点          | 标题带（中文）                                           |
| ------------------------------- | ------------- | -------------------------------------------------------- |
| `screen-1-one-click-login.png`  | 一键登录      | 一键登录：填充 → 勾选「记住我」→ 自动点击登录            |
| `screen-2-totp.png`             | TOTP 两步验证 | TOTP 两步验证：验证码和密码住在一起，不用摸手机          |
| `screen-3-multi-env.png`        | 多环境账号    | 多环境账号管理：同一站点，开发 / 测试 / 生产分得清清楚楚 |
| `screen-4-security-audit.png`   | 离线安全体检  | 离线安全体检：0-100 分给密码健康打分，全程本机计算       |
| `screen-5-preferences.png`      | 主题与双语    | 6 款主题 + 中英文双语界面，即时切换无需刷新              |
| `screen-6-local-encryption.png` | 本地加密      | 本地加密：密码只存在你的浏览器里，加密后落盘             |
| `screen-7-favorites.png`        | 收藏置顶      | 收藏常用账号：星标置顶，再一键只看收藏                   |
| `screen-8-detail-drawer.png`    | 条目详情      | 条目详情：备注、两步验证活码、修改历史一屏看全           |
| `screen-9-inline-fill.png`      | 页内填充面板  | 页内填充面板：在输入框旁边直接挑账号                     |

> 商店每个语言页的截图上限是 **5 张**，这里是 9 张候选，**最终选哪 5 张由上传时定**。
> 脚本这边的建议是 `screen-1 / 2 / 3 / 4 / 9`：前四张各占一个独立卖点（一键登录、
> 两步验证、多环境、安全体检），`screen-9` 是唯一一张展示**页内**体验的，和其余
> 「侧边栏 / 管理页」构图互补，辨识度最高。
> 需要换掉某张时，`screen-7`（收藏 + 标签 + 网站图标）和 `screen-8`（详情抽屉，
> 信息密度最高）是首选替补；`screen-6`（本地加密）画面最朴素、且该主张在摘要与
> 说明里已有文字承载，最先可舍弃。

## 文件

| 文件              | 作用                                                                         |
| ----------------- | ---------------------------------------------------------------------------- |
| `cdp.mjs`         | 极简 Chrome DevTools Protocol 客户端（原生 WebSocket）                       |
| `shot.mjs`        | 加载扩展、设备指标、等待动画收敛、截图、合成标题带、favicon 预热             |
| `demo-hosts.mjs`  | 演示域名清单与页面地址构造（seed 条目网址 / 预热 / 截图共用一份）            |
| `demo-server.mjs` | 本地 HTTPS 演示站：托管演示页并按 Host 合成站点图标（证书落在临时目录）      |
| `seed.mjs`        | 切语言 + 设主密码 + 导入 10 条占位账号 + 收藏 + 改密码造历史（可传自备 CSV） |
| `capture.mjs`     | 截图入口，`seeded` / `prefs` / `firstrun` 三种模式 × `zh` / `en`             |
| `demo-login.html` | 演示登录页（「一键登录」的已填充 + 已勾选状态）                              |
| `demo-2fa.html`   | 演示两步验证页（配合侧边栏活码展示「验证码和密码在一起」）                   |

演示账号内联在 `seed.mjs` 的 `DEMO_CSV_ZH` / `DEMO_CSV_EN`，各 **10 条**、行序严格一致
（两个商店页演示的是同一批账号）：覆盖开发 / 预发 / 生产 / 测试 / 运维 / 设计 / 文档 /
沙箱八类标签，其中 `admin.example.com` 有 3 条（主账号 + 只读 + 客服），让图 1、图 9 的
「匹配 3 个账号」有真实候选。标签列用引号包住逗号（`"生产,重要"`）来演示**多标签**，
导入后按逗号切成两个标签。另有两类刻意留下的可展示项：`ops@example.com` 带 TOTP 密钥
（图 2 与图 8 的活码来源），`dev@example.com` 用常见泄露密码、design/wiki 两条共用同一密码
（让图 4 的安全体检有发现项）。

除导入外 `seed.mjs` 还会做两件事，都是为了让特定小节渲染出来：

- **收藏**（默认 `qa-bot@example.com`、`designer@example.com`，`SHOT_FAVORITE_USERS` 覆盖）：
  图 7 的星标置顶与「只看收藏」筛选。刻意避开带 TOTP 的 `ops`——它的卡片多两个操作图标，
  会把标签挤成「运…」「重…」，在商店截图里像渲染故障。
- **改密码**（默认 `ops@example.com`，`SHOT_HISTORY_USERS` 覆盖，连改两次留两条历史）：
  图 8 抽屉里的「密码修改历史」小节是 `v-if="historyList.length > 0"`，
  只导入不改密的话整节不渲染。

改演示数据直接改那两个常量；想用**真实导出样本**拍图，把 CSV 路径作为第三个参数传入
（`node seed.mjs <extDir> zh /path/to/demo.csv`），此时务必同步传
`SHOT_FAVORITE_USERS` / `SHOT_HISTORY_USERS`，并确认样本已脱敏——这些内容会进商店素材。
