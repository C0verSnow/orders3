# Orders3 · 特洛伊资本

React + TypeScript 交易工作台，Node.js + TypeScript 负责真实 Supabase / Gate 业务、SQLite、签名、定时任务和凭证管理。当前运行与构建不依赖 C++、Qt、WebEngine 或 QWebChannel。

前端使用 React 19、TypeScript、Vite、Tailwind CSS 4 和 TanStack Query/Table。界面使用 Tailwind 工具类，共用 Button/Input/Select/Panel/Badge 组件；共享动效、设置卡片及渐隐样式集中在 tailwind.css。样式入口还包含深色模式、字体/断点及浏览器圆形揭示规则。数字与列表过渡使用浏览器 Web Animations API，支持系统减少动态效果设置，不改变交易数据与后端逻辑。

**仓库约定：不进行本地编译验证。** 代理修改时只做代码阅读、静态分析和差异检查；构建、类型检查、测试和发布包启动验证交给已有远端 Actions。未执行的检查不算通过。

## 运行发布包

普通用户完整操作步骤见 [使用手册](使用手册.md)，分别说明 Windows EXE、Linux DEB、Docker、配置优先级及日常排查。

Release 附件统一带 `v-版本`，以下 `1.0.0` 为示例，请替换成实际下载版本。自动预发布使用 `1.0.0-build.运行ID.重试号`，旧 Release 附件不会自动改名。

- Windows x64：下载 Release 的 `orders-windows-x64_v-1.0.0.exe`，双击或从终端运行。程序直接打开独立 Electron 工作台窗口；便携 exe 内含窗口运行时、Node 服务和 React 资源，无需另装 Node。
- Linux AMD64 / ARM64：下载对应 `.deb`，执行 `sudo dpkg -i orders3_v-版本_架构.deb`，再运行 `orders3` 打开内嵌窗口；`orders3 --no-browser` 保留无图形服务模式。安装器会安装 GTK/NSS 等系统依赖。
- 容器：镜像位于 [GHCR Packages](https://github.com/C0verSnow/Orders3/pkgs/container/orders3)，支持 `linux/amd64` 和 `linux/arm64`。发布状态与产物以 [Actions](https://github.com/C0verSnow/Orders3/actions) 和 [Releases](https://github.com/C0verSnow/Orders3/releases) 为准。

```sh
# Linux 发布包
orders3 --cached
orders3 --no-browser --port 8090
orders3 --fetch-only
orders3 --list
orders3 /备份目录/data.db --cached

# 容器，数据与 config 保存在命名卷
docker run -d --name orders-dashboard --restart unless-stopped \
  -p 127.0.0.1:8090:8090 -v orders-dashboard-data:/data \
  ghcr.io/c0versnow/orders3:latest --cached
docker logs orders-dashboard
```

直接进入工作台，无需登录令牌。已删除令牌输入、URL 令牌传递、会话 Cookie 和 `/api/session`；旧 `ORDERS_ACCESS_TOKEN` 不再生效。所有能连接服务的人都能访问工作台和业务 API；保留 Host/Origin 校验及写操作来源要求。默认仅监听回环地址，远程访问应由部署方在反向代理限制访问。

默认宿主机只监听 `127.0.0.1`，端口 0 自动分配；容器默认 `0.0.0.0:8090`。`--cached` 只跳过启动抓取，已启用的预测抓取、自动开仓、每分钟持仓同步及每 10 分钟独立入仓/平仓维护仍运行。`--list` 仅读取 Gate 列表，不下单。`--fetch-only` 只抓取并保存预测订单，不执行开仓。桌面发行包默认内嵌窗口，也接受 `--desktop`；窗口关闭会停止其唯一后台服务。`--no-browser` 使用无窗口服务，`--browser` 保留显式系统浏览器模式。源码 / Docker 只运行服务，不包含 Electron。

## 配置与旧数据迁移

请先备份旧 `data.db` 和 `config`，停止旧服务，再启动新程序；新旧程序不得同时操作同一数据目录或账户。新服务每个数据目录只允许一个进程，进程锁同时保护日志预算和交易串行化。旧程序不认识此锁，必须手动停止。

配置优先级继续为：INI `[environment]` > 进程环境 > `.env`。源码运行兼容根目录 `config` / `data/data.db`；发布版默认 `~/.orders-dashboard/`。有程序旁 `.env` 时优先读取它。容器使用 `/data/config` 和 `/data/data.db`。

页面“系统设置”支持 Supabase 地址、Supabase 密钥、Gate Key / Secret、数据目录和允许来源。密钥不回显；留空保留，勾选清除才清除本地值。数据目录在重启后生效，不自动搬数据。环境变量说明见 `example.env`、`example.config`。

Infisical 仍支持 Universal Auth 与两个内存备用字段：`INFISICAL_CLIENT_ID` / `INFISICAL_CLIENT_SECRET`（兼容 `CLIENT_ID` / `CLIENT_SECRET`）、`INFISICAL_PROJECT_ID`、`INFISICAL_ENVIRONMENT`（默认 prod）、`INFISICAL_SECRET_PATH`（默认 /）、`INFISICAL_URL`（默认 https://app.infisical.com）。本地凭证每个字段优先；读取失败保留上次成功备用值，5 秒后重试；每次保存设置重新读取。机器认证信息只能在服务端启动环境配置。

旧 records / record_json、orders 别名列、orderslist、position、入仓历史、同步水位和固定保证金继续读取。刷新在事务中替换自己的快照；`managed_close_orders` 历史表不删除也不使用。旧 `trigger_price` 不当作激活价格，必须重新同步 Gate。详细见 [数据库](docs/database.md)、[迁移说明](docs/migration.md) 和 [业务对照](docs/business-parity.md)。

## 执行流程审查

[检查报告（issue #33）](检查报告.md) 按启动、数据同步、交易执行、持仓保护、异常恢复和前后端交互梳理函数。正文保留 `358df62` 的审查基线；开头处理表说明本 PR 的修复及保守处理方式。CI 不替代实盘验收。

## 交易规则与精度

每 10 分钟独立同步真实入仓历史、补齐固定保证金并维护只减仓平仓追踪单。按已确认的历史策略计算激活价，已激活单保留并阻止同方向补单，详见 [平仓规则](docs/close-position-orders.md)。订单和持仓分别显示同步时间；只刷新订单不会把旧持仓标成最新。

人工解除待核对请求时，必须恢复原 API Key、填写核对依据，并成功读取订单、持仓和七天成交历史。新意图保存 Key 的 SHA256 指纹，创建请求另带唯一 `t-` 关联标识。指纹不是交易所账户 ID，程序不声称自动证明成交结果。旧版缺失指纹的记录禁止在线解除。

来源从 Supabase `public.orders` 完整分页读取，全部校验后保存。保存来源不会开仓；独立的自动开仓任务默认关闭，启用并到达计划时间后才按策略匹配开仓追踪单，数量正负决定方向。状态 1 可停止，状态 2 保留；真实开仓/加仓成交触发同合约同方向 7 天限制，历史最多保留 100 条。持仓与订单每分钟独立同步，仅发送读取请求，不依赖 Supabase 来源步长。

页面价格、数量、持仓、盈亏使用 Decimal ROUND_HALF_UP 显示两位小数；计算和下单不受两位小数限制。来源每个合约必须提供正数 `order_price_round`，作为开仓最终下单步长，按 ROUND_HALF_EVEN 对齐；Gate `order_price_round` 独立校验最终价格，乘数和数量限制仍来自 Gate。比如 `100.005` 按 `0.001` 下单仍为 `100.005`，页面显示 `100.01`。`0.005` 表示整数倍步长，不是三位小数。缺失、无效或同合约不同 `order_price_round`、对齐后非正价格、Gate 步长冲突或张数越界，**整批交易在撤单和创建前停止**。Supabase 步长读取时保存为内部 `price_round`，不会被 Gate 同名字段覆盖，不回退读取 Supabase 旧 `price_round` 列。持仓刷新不计算保护价，也不读取来源步长。原始来源、交易 raw 字段和持仓计算值保留高精度，旧库中已舍入且没有 raw 的值无法恢复。

每笔交易先持久化意图。网络中断、无有效订单 ID 或成功响应后本地写入失败时，待核对意图会阻止自动交易，包括重启后。先在 Gate 查明真实结果，再到“运行状态”确认解除；确认会读取订单、持仓和成交，并记录人工核对依据后解除本地阻断，不重发原请求。刷新按钮会执行真实策略，页面要求确认；读取页面不会触发交易。

请求日志位于数据目录 `logs/requests.jsonl`，不保存查询参数、头、正文或凭证；10 MB × 5，总计 50 MB。数据目录 SQLite 主文件合计上限 450 MB，事务超限回滚。WAL、临时文件与下载快照另占空间。新服务持有目录锁期间，外部程序直接写库不受预算保护。

## 源码开发与远端验证

Node **24.22.1**，使用 lockfile 安装。前后端可以分别构建和部署；生产也可由 Node 从内嵌资源分发 React。

```sh
npm ci
# 开发：两个终端；先设置允许 Vite 的来源
# config 的 [environment] 若已保存同名变量，需同步修改
ORDERS_ALLOWED_ORIGIN=http://127.0.0.1:5173 ORDERS_PORT=8090 npm run dev:server
npm run dev
```

Vite 默认代理 `/api` 到 8090；开发环境直接打开启动页，无需服务端登录令牌。独立前端部署推荐反向代理相同 Origin 的 `/api`，配置 `ORDERS_ALLOWED_ORIGIN` 为外部来源，保留原 Host；远程访问使用 TLS 或 SSH 隧道。

以下由**远端 CI**执行，代理不得在本地运行构建/类型检查：`npm run typecheck`、`npm test`、`npm run build`、`npm run package:exe`、`npm run package:deb`。`npm run check` 只解析语法和检查架构，不发出或编译代码。

Actions 验证精度、历史、匹配、未知交易、旧库、事务预算、配置脱敏、免登录访问与 Origin；构建 React 后检查 1920/1440/1280 三种桌面宽度，双主题、直接访问、设置和页面溢出，并上传截图。Windows 与 Linux 两架构原生 Runner 制作、安装/启动真实 exe/deb，容器两架构分别启动后才合并 manifest。CI 不连接真实账户或下真实订单。

正式 `v*` 标签与默认分支 main 自动发布；手动运行工作流并勾选 `publish_preview` 可为 feature 分支当前 SHA 发布预发布版本，不更新 latest 或部署生产。Release 包含 exe、两种 deb、SHA256SUMS、源提交与容器 digest。默认分支的 Tailscale/SSH 自动部署使用本次验证的不可变 digest。工作流读取 GitHub 默认分支，后续改名不用再改发布条件。详情见 [部署说明](docs/deployment.md)。

## 宿主机 Docker 自动更新

macOS/Linux 宿主机仍可运行 `bash start-docker.sh --cached`；它先拉取镜像，再替换旧容器，保留命名卷，自动映射回环随机端口，成功后写两行 `docker.md`。使用 `docker logs 容器名称` 查看服务状态。旧卷若属于 root，升级前将卷内数据属主改为镜像 node 用户（UID/GID 1000），或明确配置合适的运行用户；新镜像默认非 root。

远程使用 SSH 隧道，例如 `ssh -N -L 8090:127.0.0.1:服务器随机端口 用户@服务器`，浏览器访问本机 8090。此时需将服务端允许来源设为实际浏览器 Origin，并保留与之匹配的 Host；随机端口变化时更新隧道。首次可让本机隧道端口与服务器随机端口一致，使用默认来源校验。

历史 Python 归档只供对照，不参与构建；旧 C++ 实现可从 Git 历史查看。

### 独立自动开仓（PR #34 最新评论）

```ini
[schedule]
enabled = true
cron = */15 * * * *

[opening]
enabled = false
cron = */15 * * * *
```

预测抓取、启动同步、手动刷新和 `--fetch-only` 都不交易。要自动开仓，先成功抓取有效预测订单，再在系统设置的独立表单启用“自动开仓”并设置 Cron。关闭预测抓取不会关闭已授权的开仓任务；开仓使用当前保存的数据，不强制在每次开仓前抓取。两项同时到期时先完成抓取；任务忙、错过或失败不会无限重试。

计划执行按任务名与计划时间写入 SQLite `scheduled_runs`，同一批次只领取一次；重启将未完成批次标为未知，不补跑。每次交易 POST 前重新检查启用状态、配置版本和执行记录；关闭开关会阻止后续 POST，不能撤回已发出的请求。交易结果未知仍须在“运行状态”按原凭证核对 Gate 后人工解除阻断，不自动重发。配置文件手动修改后请重启。

界面使用统一四字名称和 SVG O 标志。右上角提供一个明暗主题切换按钮及 ZH / EN 语言切换；浅色、深色、跟随系统三项选择位于系统设置的外观主题中；下载数据库位于左侧导航底部。主题与中英文双向切换采用以实际点击按钮中心为原点的 600ms 圆形揭示，语言选择保存在当前浏览器；切换不重置搜索、分页或未保存的设置草稿。支持国际化的界面文案与已知服务端提示会翻译，原始来源记录、技术字段、第三方原始错误及交易数据保留原值。浏览器不支持 View Transitions 或系统要求减少动态效果时直接切换。数字/文字过渡为 850/550ms，行进入退出为 750ms、进入间隔 90ms；滚动边缘按行位置连续淡出，表头和详情按钮保持可见。系统减少动态效果时关闭非必要动画。

手动交易保留在“预测订单 → 手动开仓”，先刷新并核对有效预测数据，再单独确认真实交易。该入口独立于自动任务开关；关闭自动开仓不禁止经确认的手动交易。刷新按钮本身始终只读。


## Issue #36：设置导航与按钮反馈

系统设置首页仅展示四张等高横向卡片：外观设置、连接与存储、预测抓取、自动开仓。点击卡片进入对应表单，使用“返回设置”回到概览。中英文同步；切换模块和语言保留未保存草稿，成功保存后按服务端结果更新。原有凭证清除、重启提示和独立自动开仓授权均保留。

操作按钮统一采用 180ms 悬停上移 2px、按压缩放至 94% 的动效。异步操作在按钮内显示加载、成功或失败状态；保存按钮反馈 1.8 秒后恢复，刷新按钮成功 900ms、失败 1800ms 后恢复。刷新反馈只属于实际点击的按钮，切页不重播已过期的结果，旧计时器不影响新请求；保留可访问错误原因，禁用时阻止重复提交。预留各状态及中英文尺寸，避免标签切换推动相邻元素；减少动态效果时关闭位移。持仓页使用全局“统一刷新”及既有后台同步，移除多余同步按钮。

远端跨平台视觉验收分别启动真实 Windows EXE 与 Linux Docker，固定 Chromium、字体、数据、UTC、缩放和桌面视口（1440/1280px），捕获 96 个场景，比较全表视口和底部 48px 两个区域。精确像素差异和预设容差结果分别报告：保留全部原始差异；单通道差异超过 32/255 且未被识别为边缘抗锯齿的像素不得超过比较区域的 2%。抗锯齿像素单列统计，不宣称逐像素完全相同。Artifacts 中的 `platform-windows`、`platform-docker` 保存原图与环境清单，`platform-visual-comparison` 保存差异 PNG、JSON 和 Markdown 报告。运行状态见 [PR #37](https://github.com/C0verSnow/Orders3/pull/37/checks)，尚未完成的运行不代表已验证。

用户于 2026-10-20 要求跳过手机和平板检查。常规 CI 仅验收桌面（1920/1440/1280px）；按 PR #37 最新评论，另加 1440px/390px 明暗主题刷新专项回归。专项通过不代表完整移动端已验收。Issue #36 当时跳过了平板及跨平台截图/字体/像素检查；当前跨平台策略以下方 issue #41 为准。

按 issue #41，push、PR 和标签触发时默认执行跨平台截图、字体诊断和像素比较。手动运行默认勾选 `run_visual_checks`；取消勾选会一起跳过 Windows/Linux 截图、上传和对比，跳过不算通过。失败的视觉检查会阻止发布。业务、桌面功能、类型、构建、安装包和容器检查继续执行。安全维护和验证说明见 [issue #41](docs/issue-41.md)。

Issue #36 的保留验收项目已在[最终远端 CI](https://github.com/C0verSnow/Orders3/actions/runs/39385666385)全部通过；跨平台视觉检查按用户要求跳过，不作通过声明。具体源码行号、验证范围及历史报告见 [交付文档](docs/issue-36.md)。PR #37 保持开放，issue #36 已关闭。

## Issue #39：桌面窗口与四行表格

Windows x64、Linux AMD64/ARM64 桌面发行包集成 Electron 45，业务仍由原 Node SEA 服务运行。窗口禁用 Node 集成、开启上下文隔离与沙箱；等待本地服务就绪后再加载。关闭窗口通过父子进程私有管道正常停止服务；父进程退出时管道关闭也会触发清理。启动失败显示错误。

预测订单、跟踪订单、当前持仓、入仓历史统一每页 4 条、64px 行高与 312px 表格视口（包含表头和横向滚动余量），不足部分保留空白。搜索和刷新使页码失效时调整到有效页；翻页不保留旧页退出行。预测页仅保留原手动开仓按钮，全局统一刷新与概览刷新来源继续可用。

远端验证与具体限制见 [issue #39 说明](docs/issue-39.md)。

Issue #43 的部署地址、独立入仓历史及平仓维护交付和远端验证见[交付记录](docs/issue-43.md)。

### 开仓时提示“数据任务正在运行”

先看“运行状态”当前是否还有任务，再看定时开仓的上次执行时间。旧版每天整点开仓可能连续撞上每分钟后台订单同步，失败提示会一直保留，详见 [issue #45 排查与修复](docs/issue-45-task-contention.md)。新版后台订单同步在自动开仓前一分钟让路；遇到其他占用仍跳过，并显示任务名称和运行秒数，不排队补跑。请求最多 30 秒、整批任务最多 300 秒；交易写入结果未知时仍须人工核对，不能自动重发。
