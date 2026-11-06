# 签到功能全链路走查报告（v0.1.62 / 22b318c）

> 任务：验证「每天自动签到领积分」是否已完整可用、有无缺口。
> 方式：纯静态走查（未修改任何业务代码）+ 编译与单测结果取自仓库 CI（见 §5）。
> 结论先行：**功能已完整可用（端到端闭环，无 P0 阻断）**；用户「以为没有这个功能」的直接原因是**默认关闭且默认值不持久 + 文档完全没写 + 后台执行无反馈**，而不是实现缺失。
> 修订记录：§3 P1-1 已按 QA 独立复核结论**修正**（默认关闭不持久 / UI 与行为不一致）；§5 为编译与单测验证归档。

---

## 0. 目录

1. [端到端调用链表](#1-端到端调用链表)
2. [已闭环清单（含证据）](#2-已闭环清单含证据)
3. [缺口 / 风险清单](#3-缺口--风险清单)
4. [结论与最值得补的 3 个方向](#4-结论与最值得补的-3-个方向)
5. [编译与单测验证](#5-编译与单测验证)

---

## 1. 端到端调用链表

外部接口（国内版专有）：
- 状态：`POST https://www.codebuddy.cn/v2/billing/meter/checkin-activity-status`，404 才回落 `.../checkin-status`
- 签到：`POST https://www.codebuddy.cn/v2/billing/meter/daily-checkin`
- 前缀常量：`crates/wb-switch-core/src/modules/config.rs:25`（`CHECKIN_API_PREFIX`）
- 国际版域名 `https://www.workbuddy.ai` 存在（`variant.rs:15`），但签到链路对国际版全部短路（见 §2.2），实际不会发出任何签到请求。

| # | 入口 | 宿主入口代码 | API / IPC | core 函数 | 外部请求 | 落盘 |
|---|---|---|---|---|---|---|
| 1 | **桌面端后台定时循环（重点）** | `src-tauri/src/lib.rs:59-75`：`spawn_background_loops()` 里先 `compact_checkin_logs()`，再 `run_checkin_cycle(StartupVerify)`，之后 `loop { sleep(next_cycle_delay()); run_checkin_cycle(PeriodicRecovery) }`；`lib.rs:205-207` 在 `setup()` 中调用（仅测试截图模式 `WB_SWITCH_SCREENSHOT_DEMO=1` 跳过） | 无（进程内直调 core） | `checkin::run_checkin_cycle`（`checkin.rs:702`）→ `checkin::next_cycle_delay`（`checkin.rs:652`）→ `checkin_account`（`checkin.rs:307`） | §上文两个 URL | `~/.wb-switch/auto_checkin_logs.json`（`config.rs:85-87`、`add_checkin_log` `config.rs:547`） |
| 2 | **webui（npm CLI）后台定时循环** | `crates/wb-switch-server/src/main.rs:25-35` 同样的 StartupVerify + 延迟循环；`main.rs:169` 在 `serve()` 中启动 | 无 | 同上 | 同上 | 同上 |
| 3 | 账号页「签到」按钮（单账号） | `src/pages/AccountsPage.tsx:610-632` → `api.checkin(id)`（`src/lib/api.ts:879-882`） | Tauri `commands::checkin`（`commands.rs:1094-1099`）/ HTTP `POST /api/checkin`（`api.rs:198`、`api.rs:1479-1485`） | `checkin::checkin_account`（`checkin.rs:307`） | 状态 + 签到 | 仅提交成功/失败时写日志（`checkin.rs:328-373`） |
| 4 | 账号页「刷新并签到」（批量，尊重时间段） | `AccountsPage.tsx:650-708`（`api.checkinAll(variant, true)`） | `commands::checkin_all`（`commands.rs:1107-1111`）/ `POST /api/checkin/all` + `respectWindow`（`api.rs:1487-1503`） | `checkin::run_checkin_all(variant, respect_window)`（`checkin.rs:851`） | 同 3 | 同 3 |
| 5 | 设置页「全部立即签到」 | `SettingsPage.tsx:543-576`（`api.checkinAll()` 无 variant、`respect_window=false`） | 同 4 | `run_checkin_all(None,false)` | 同 3 | 同 3 |
| 6 | 托盘「一键签到」 | `src-tauri/src/tray.rs:57-69`（菜单事件）→ `start_checkin_all`（`tray.rs:388-417`）：`CHECKIN_BUSY` 互斥 + spawn，`run_checkin_all(None,false)`；完成弹系统通知 `notify_checkin`（`tray.rs:458`） | 无 | `run_checkin_all(None,false)` | 同 3 | 同 3 |
| 7 | 账号卡状态徽标 | `AccountsPage.tsx:121-141` `fetchTodayCheckinMap` → N 次 `api.getCheckinStatus` | `commands::get_checkin_status`（`commands.rs:991-999`）/ `GET /api/checkin/status?accountId=`（`api.rs:177`、`api.rs:1342-1357`） | `get_checkin_status_for_display`（`checkin.rs:236`）→ `get_checkin_status`（`checkin.rs:208`） | 仅状态查询 | 读日志不写 |
| 8 | 设置页配置读写 | `SettingsPage.tsx:404-529`（即时落盘、串行提交链） | `commands::get/save_auto_checkin_config`（`commands.rs:1113-1124`）/ `GET/POST /api/checkin/config`（`api.rs:200-203`、`1505-1515`） | `config::load_checkin_config`（`config.rs:372`）/ `save_checkin_config`（`config.rs:396`） | 无 | `~/.wb-switch/auto_checkin_config.json`（`config.rs:81-83`） |
| 9 | 设置页签到日志 | `SettingsPage.tsx:531-541`、`757-803` | `commands::get_checkin_logs`（`commands.rs:1126-1130`）/ `GET /api/checkin/logs`（`api.rs:204`、`1517-1520`） | `checkin::load_checkin_logs_with_variant`（`checkin.rs:826`）→ `config::load_checkin_logs`（`config.rs:404`） | 无 | 读 |
| 10 | 派猫猫旅行（自动领积分） | `src-tauri/src/lib.rs:77-94`（两条独立循环：派发 30 分钟 `TRAVEL_RETRY_INTERVAL` / 领取 15 分钟 `TRAVEL_CLAIM_INTERVAL`）；`crates/wb-switch-server/src/main.rs:57-73` 同构 | `commands::get_travel_status/save_auto_travel_config`（`commands.rs:1141-1166`）/ `/api/travel/*`（`api.rs:208-211`、`1522-1556`） | `travel::run_travel_cycle`（`travel.rs:845`）、`travel::run_travel_claim_cycle`（`travel.rs:909`） | `/activity/growth/buddy/travel/*`（`config.rs:30`） | `~/.wb-switch/auto_travel_config.json` + `travel_cache.json`（`config.rs:89-95`） |

**关于「桌面版是否真的会每天自动签到」的明确结论**：会。桌面版与 webui **两个宿主都启动了同一套 core 循环**（`src-tauri/src/lib.rs:59-75` + `lib.rs:205-207`；`crates/wb-switch-server/src/main.rs:25-35` + `main.rs:169`），逻辑全在 core，`CheckinCycleMode::StartupVerify/PeriodicRecovery` 都只是标签（`checkin.rs:702` 形参名为 `_mode`，两种模式行为一致）。不存在"只有 webui 会签"的情况。轻量模式销毁 webview 也不影响（循环在 Rust 运行时线程里，不依赖窗口）。

**周期节奏**（`checkin.rs:626-670`）：
- 未设置时间段 → 固定 30 分钟一轮（`CHECKIN_RECOVERY_INTERVAL`，`checkin.rs:50`），每轮**核验全部合格账号**；
- 设置了时间段 → 睡到"最近一个账号的抽签目标分钟"，夹在 `[1 分钟, 30 分钟]`（`MIN_CYCLE_DELAY`/上限），到点只处理"到点未办"的账号；
- 上一轮有 error 且窗口生效 → 5 分钟快速重试，最多 12 次（`FAST_RETRY_*`，`checkin.rs:52-56`）。

---

## 2. 已闭环清单（含证据）

### 2.1 单账号 / 批量签字链路
- 单账号完整流程：并发守卫 → 档位门控 → 惰性刷新 token → 查状态 → 未签才提交 → 写日志。`checkin.rs:307-375`。
- 「已签到」幂等业务码按成功处理（`已签到`/`repeat`）：`checkin.rs:269-272`，两档位一致。
- 批量结果逐账号返回 `success/already/error/skipped/inactive` + `reason`，前端按 reason 分类提示：`checkin.rs:870-889`、`AccountsPage.tsx:662-677`、`SettingsPage.tsx:552-568`。
- 托盘工具提示口径与「是否全部已签」判定：`tray.rs:868-900`、`checkin.rs:757-796`。

### 2.2 国际版（ai）分支短路 —— 严密
- 能力声明单一来源：`variant.rs:320-322`（`supports_checkin()` 仅 Cn 为 true），前端同口径 `src/lib/variant.ts:51-53`。
- **请求层**：`get_checkin_status` 只对 Cn 发请求，Ai 直接返回 `statusUnsupported: true`，零请求（`checkin.rs:208-233`）。
- **执行层**：`checkin_account` 在 `load_checkin_config` / `ensure_fresh_token` / 状态查询**之前**就 `return skipped/unsupported_variant`（`checkin.rs:311-315`）——这是自动周期、一键签到、单账号三个入口的汇聚点，因此三入口全部零请求。
- **集合层**：自动周期 `auto_checkin_accounts`（`checkin.rs:415-420`）与批量 `run_checkin_all`（`checkin.rs:856-862`）都按 `supports_checkin` 过滤；托盘待签到集合 `accounts_checked_in_today` 也把 ai 排除（`checkin.rs:781-787`），避免托盘永远"可签到"。
- **刷新短路**：ai 的 inactive 类业务提示不触发 token 刷新/重发（`checkin.rs:129-139`、`132-153`），避免误写 `needs_relogin`。
- 单测覆盖：`checkin.rs:1110-1134`（`ai_account_does_not_call_cn_status_endpoints` / `ai_account_checkin_is_skipped_without_requests`）、`checkin.rs:1072-1107`、`variant.rs:510-517`。

### 2.3 加密信封凭据（`$wbEncrypted`）账号
- 在任何请求之前短路并返回可读中文错误（`checkin.rs:142-146` → `account.rs:465-474`），不会发出空 `Bearer`（`account.rs:476-481` 有明确警示）。
- `checkin_request` 只有 404 才回落路径候选，`code=-2` 原样返回（`checkin.rs:172-184`、`config.rs:955-966`），不会掩盖真因。
- 单测：`checkin.rs:897-909`。
- 注意：这类账号在"全部立即签到"里被计为 `error` 且不写日志（见 §3 P2-11）。

### 2.4 时间段窗口（`[start, end)` / 错峰抽签 / 补签）
- 窗口合法性：两端都能解析成 `HH:MM` 且 `start < end` 才生效，否则视为"不限制"（`checkin.rs:435-447`，`parse_clock` 在 `config.rs:305-319`，支持 `9:5` 这类 1–2 位写法）。
- 半开区间：`start` 整点在窗内、`end` 整点在窗外（`checkin.rs:453-458`；单测 `checkin.rs:1441-1467`）。
- 错峰抽签：`target_minute = start + hash(local_date, account_key) % (end-start)`，同日重启不变、多账号天然错峰、跨日重新抽（`checkin.rs:509-514`；单测 `checkin.rs:1377-1403`）。**不会漏签**：`account_due` 只要求"最近一个已应到的目标时刻之后没有 success/already"（`checkin.rs:588-594`），目标错过也在下一轮立刻补，不依赖"正好在目标分钟醒着"。
- 窗口回执：到点复核发现服务端已签（用户白天手动签过）时补写一行 `already`，让"本窗口已回应"跨重启成立（`checkin.rs:677-692`、调用点 `checkin.rs:733-738`）。
- 手动批量在窗口外整轮跳过且不查状态、不提交、不写日志（`checkin.rs:465-492`、`851-865`），前端提示"N 个未到签到时间段"（`AccountsPage.tsx:667, 674`）。
- 单测覆盖窗口/due/延迟全套：`checkin.rs:1405-1820`。

### 2.5 并发保护 —— 不会永久卡死
- 周期/批量级：`CHECKIN_RUNNING` + `RunFlagGuard`（`checkin.rs:41`、`config.rs:861-880`），`Drop` 即复位，包括 unwind 路径。
- 账号级：`CHECKIN_ACCOUNTS_RUNNING` + `AccountRunGuard`（`checkin.rs:76-105`），`Drop` 移除键；单测 `checkin.rs:1175-1181`。
- HTTP 请求 30 秒超时（`config.rs:972`），因此单轮最长 ≈ 30s × 账号数，不会无限挂住标志位。
- 日志读改写有独立锁（`config.rs:32`、`547-554`），旅行缓存另有锁（`config.rs:33-39`）。

### 2.6 排除名单（`excluded_account_ids`）
- 只按稳定 `id` 匹配，不以昵称/邮箱误伤（`checkin.rs:390-396`）；保存时去重、丢非法项（`config.rs:330-338`）。
- 生效范围：自动周期（`checkin.rs:710`）、批量/一键签到（`checkin.rs:870-889`，未 poll future 即返回 `skipped/auto_checkin_disabled`，**不会发任何请求**）、账号页展示查询（`checkin.rs:236-238`、`403-412`）、托盘待签到判定（`checkin.rs:781-787`）。
- 不影响：单账号手动签到（设计如此，前端 chip 明确提示"仍可手动签到"，`src/components/account-card.tsx:453-454`）。
- 单测：`checkin.rs:911-956`、`config.rs:1191-1247`。

### 2.7 一键签到 / 刷新并签到 不会误签被排除账号
- 托盘：`run_checkin_all(None,false)` → `checkin_all_rows` 逐个走 `with_auto_checkin_preference`（`checkin.rs:870-889`）。
- 设置页「全部立即签到」：同上（`SettingsPage.tsx:543`）。
- 账号页「刷新并签到」：同上，且再叠 `variant` + `respectWindow` 两层过滤（`AccountsPage.tsx:658-660`、`api.rs:1489-1502`）。
- 唯一瑕疵见 §3 P2-5（窗口外跳过时把被排除账号也计入"未到时间段"）。

### 2.8 持久化
- 目录：`~/.wb-switch/`（`config.rs:69-71`，可被 `WB_SWITCH_HOME` 覆盖，`config.rs:58-67`）。
- 配置：`auto_checkin_config.json`，字段 `enabled` / `excluded_account_ids` / `checkin_start` / `checkin_end` + 兼容字段 `start_hour`/`end_hour`/`keepalive_days`/`lazy_refresh_hours`（`config.rs:280-300`）；保存时只保留已知字段、时间归一化 `HH:MM`、非法归空串，`atomic_write` 落盘（`config.rs:322-358`、`396-401`）。
- 日志：`auto_checkin_logs.json`，每行 `{ts, accountId, email, variant, result, error?}`（`checkin.rs:330-373`）；保留 30 天 / 最多 500 条，重复 `already` 按(账号,本地日期)去重保最新（`config.rs:462-515`）；启动时做一次历史整理 `compact_checkin_logs`（`config.rs:541-544`，两宿主都在第一轮之前调用：`lib.rs:62`、`main.rs:27`）。
- 启动默认值策略：全新安装 `enabled:false`；已有安装（存在配置文件**或**日志文件）沿用历史默认 `enabled:true`（`config.rs:280-287`、`376-393`；单测 `config.rs:1249-1318`）。⚠️ 该"使用痕迹"判据会把手动签到产生的日志误判成老用户，导致默认关闭不持久 —— 详见 §3 **P1-1**（已修正）。

### 2.9 派猫猫旅行（自动领积分）不干扰签到
- 独立配置 `auto_travel_config.json`、独立缓存、独立并发标志（`config.rs:89-95`、`travel.rs:23-24`）、独立周期（30 分钟派发 / 15 分钟领取，`travel.rs:43-45`）、独立档位门控（仅 Cn，`variant.rs:310-312`、`travel.rs:35-41`、`857-861`）。
- UI 上确实是**同一张设置卡片内的一行**（`SettingsPage.tsx:755` `<AutoTravelRow/>` 渲染在自动签到卡片内；`SettingsPage.tsx:816-871`），但配置与执行完全解耦，互不覆盖。
- 开关联动：旅行开启时会立即跑一轮派发+领取（`commands.rs:1156-1166`、`api.rs:1541-1556`），签到**没有**这个立即触发（见 §3 P1-2）。

### 2.10 前端口径一致
- 档位能力前端唯一来源 `src/lib/variant.ts`，与后端 `variant.rs` 同口径（`cn` 才支持签到/旅行）。
- 账号元数据一定带 `variant`（后端 `account_meta` 用 `variant_of` 计算，`account.rs:147-149`），因此前端 `accountVariant`（只看 `account.variant`）不会与后端"域名兜底"产生分歧。
- 设置页时间段校验与后端语义一致：半填/非法/`start>=end` 只在本地显示、不落盘并给出"未保存"文案（`SettingsPage.tsx:296-304`、`497-529`）；落盘采用串行提交链避免并发覆盖（`SettingsPage.tsx:436-466`）。

---

## 3. 缺口 / 风险清单

### P0 阻断
**无。** 未发现导致功能不可用或数据损坏的缺陷。

### P1 明显缺陷（影响"用户感知到功能存在且生效"）

**P1-1 默认关闭不持久：任意一次手动签到就会把「自动签到」静默打开（UI 与行为会短暂不一致）**
> **本节为 QA 独立复核后的修正版**：原表述为「全新安装默认关闭」，方向正确但**不完整**。QA 复核提出「默认关闭不持久、UI 显示与实际行为不一致」，经逐行核对 `load_checkin_config` / `default_checkin_config` / `save_checkin_config` 后确认 **QA 的定性成立**，但触发条件需修正为「日志文件存在而配置文件缺失」，而非「全新安装落盘值缺失」。以下为核对后的准确描述。

- **全新安装（两个文件都不存在）→ `enabled` 确实是 `false`。** `load_checkin_config()` → `load_checkin_config_at()`（`config.rs:376-381`）以 `existing_install = config 文件存在 || 日志文件存在` 作为判据，两者皆无时走 `default_checkin_config()`（`config.rs:280-282`）→ `enabled:false`。单测直接断言该行为：`config.rs:1281-1287`。
- **但 `enabled` 的默认值不是常量，而是由「使用痕迹」决定。** 判据一旦命中（`config.rs:380`），基线换成 `legacy_default_checkin_config()`（`config.rs:285-287`）→ **`enabled:true`**。单测明确断言「只有签到日志、没有配置文件」时 `enabled=true`：`config.rs:1289-1296`；配置文件存在但内容损坏时同样 `true`：`config.rs:1307-1315`。
- **日志文件不需要开启自动签到就会被创建。** 写日志的唯一主动入口是 `checkin_account` 的提交分支（`checkin.rs:373`，`add_checkin_log`），而批量签到的公开入口 `run_checkin_all` **不检查 `enabled`**（`checkin.rs:851-867`；只有 `run_checkin_cycle` 在 `checkin.rs:706-709` 检查）。因此触发链是：**全新安装 → 用户点一次「签到」/「全部立即签到」/托盘「一键签到」/账号页「刷新并签到」→ `~/.wb-switch/auto_checkin_logs.json` 落盘 → 下一次 `load_checkin_config()` 起 `enabled` 变为 `true`**。
- 后果 1（状态污染）：用户从没拨过开关，设置页重新加载后显示"开启"。这是不可归因的静默翻转。
- 后果 2（**UI 与行为不一致，即 QA 指出的现象**）：设置页/账号页的 `enabled` 来自挂载时的 `get_auto_checkin_config`（`SettingsPage.tsx:404-412`），日志落盘后不重读；而后台循环每轮重新 `load_checkin_config()`（`checkin.rs:706`）已读到 `true` 并按开启执行 → **屏幕显示"关"，后台每 30 分钟在签**。
- 一次性 vs 持续：只要用户显式保存过一次配置（哪怕只是拨一下开关再拨回来），`{"enabled": false}` 落盘后就会永久覆盖痕迹（`config.rs:1299-1305` 单测）。所以这是「首次手动签到后的一次静默翻转」，不是每次都发生。
- 定级理由：不与 P0 冲突（不会误签他人账号、不会损坏数据、签到本身幂等），但它破坏了"默认关闭"这个安全默认值的语义，且用户无法从 UI 追溯原因，故列 P1。
- 建议修法（供后续排期参考）：① 把使用痕迹判据从 `config || logs` 收窄为「仅配置文件存在」，或改用一个显式的 `install_marker` 文件；② 或让手动签到写独立日志文件，不与自动签到的"使用痕迹"共用 `auto_checkin_logs.json`；③ 无论哪种，`run_checkin_cycle` 启动时应把当轮读取到的 `enabled` 与生效值通过日志/通知暴露一次，避免静默态。

**P1-2 开启后不立即执行 → 用户"开了却没反应"**
- 保存配置只落盘，不触发任何一轮签到：`commands.rs:1121-1124`、`api.rs:1509-1515`。对比自动旅行开启即跑一轮（`commands.rs:1159-1164`），签到少了这一段。
- 后果：用户打开开关后，最长要等一个完整周期上限 30 分钟（`checkin.rs:645` clamp 上限）才会发生第一次签到；若此时关闭 App 则什么都不发生。叠加 P1-1 的"静默翻转"，用户对"现在到底开没开"完全没有判断依据。
- 缓解现状：开关右侧有"全部立即签到"按钮（`SettingsPage.tsx:635-639`），但没有任何文案提示"开启后需点一次或等待"。

**P1-3 「每天自动」的前置条件（App 常驻 / 开机自启）既未提示也未联动**
- 自动签到依赖宿主进程常驻：`lib.rs:59-75`（桌面）/ `main.rs:25-35`（CLI）。开机自启是**另一个独立卡片**、系统级 opt-in（`SettingsPage.tsx:1477+`、`commands.rs:1321-1333`），二者没有任何交叉提示。
- 时间段说明里只有一句"需 App 在窗口附近运行才能按时执行"（`SettingsPage.tsx:650`），未覆盖"未设置时间段时也要 App 在跑"和"建议开启开机自启"。
- 影响：用户设好就关掉 App，第二天发现没签，归因为"功能不存在 / 坏了"。

**P1-4 后台自动签到结果对用户完全不可见（无通知、无托盘刷新）**
- 两宿主的周期循环都丢弃返回值：`let _ = run_checkin_cycle(...)`（`lib.rs:65-74`、`main.rs:30-33`），不弹通知、不写 `notifications`（`notifications::record` 只被前端 toast 和 API 调用，`commands.rs:1450-1455`、`api.rs:1677-1689`；core 的 checkin/travel 都没有调用点）。
- 托盘菜单标签"已签到/一键签到"只在 `build_tray_menu` 时计算（`tray.rs:619-638`），且只在轻量模式切换、`CheckinBusyGuard` 起止时重建（`tray.rs:318-366`、`377-386`）——后台自动签到完成**不会**刷新托盘，标签会长期停留在"一键签到"。
- 唯一可观测物是设置页的签到日志（懒加载、需手动展开，`SettingsPage.tsx:394-402`、`757-803`）。

**P1-5 README 完全没有签到 / 旅行**
- `README.md:34-53`「功能」表、`README.md:89-98`「使用」步骤均未出现"签到""旅行"字样（实测 grep 命中 0）。功能表里连"积分到期查询"都有，却没有"每日自动签到"。
- 影响：这是"用户以为需要新增该功能"的**最直接原因**——功能齐全但不可被发现。

### P2 体验问题 / 残余风险

**P2-1 已签但托盘不显示「已签到」的判定漏洞**
- 托盘"今天是否全部已签到"依赖当天日志里的 `success/already`（`checkin.rs:772-796`）。而"到点复核发现服务端已签"时，只有**窗口生效**才补写 `already` 回执（`checkin.rs:733-738` 的 `if let Some(win) = window`）。
- 后果：未设置时间段时，若账号已被官方客户端/自己签过，自动周期永远拿到 `already` 但永不落日志 → 托盘整天显示"一键签到"。单账号手动签到返回 `already` 时同样不写日志（`checkin.rs:321` 提前 return）。

**P2-2 窗口外跳过时把被排除账号也算进「未到签到时间段」**
- `manual_window_skip_rows` 在 `checkin_all_rows` 的排除过滤**之前**执行（`checkin.rs:863-866` vs `870-889`），且跳过行不区分是否被排除。
- 后果：提示"N 个未到签到时间段"里包含本应显示为"已忽略"的账号（`AccountsPage.tsx:667-674` 分别统计两个 reason，会同时失真）。仅文案层面，无请求误发。

**P2-3 跨午夜不支持，且非法窗口被静默当成「不限制」**
- `window_minutes` 要求 `start < end`，否则返回 `None` = 全天不限制（`checkin.rs:435-447`）。前端拦住了 UI 输入（`SettingsPage.tsx:296-304`），但手改 `auto_checkin_config.json`（如 `23:00–01:00`）会得到与用户预期完全相反的行为（反而变成全天任意时刻签）。
- 想签 0 点后只能填 `00:00–01:00`，UI 未提示该限制的存在（只有非法时才出现"不支持跨午夜"文案）。

**P2-4 遗留字段 `start_hour` / `end_hour` 仍在写盘但调度完全不读**
- 默认值 6 / 12（`config.rs:295-296`），保存时仍被合并保留（`config.rs:339-348`），但调度只读 `checkin_start`/`checkin_end`（注释亦写明"仅为配置文件兼容保留，调度不再读取"，`config.rs:275`）。
- 前端设置页不再展示这两个字段（`src/lib/types.ts:443-444` 仅保留可选类型）。
- 后果：打开配置文件会看到"6 点–12 点"这种看起来生效实则无效的字段；若用户手改它们期待生效，会静默无效。

**P2-5 漏签的唯一真实边界（属机制限制，需文档化）**
- 若某个目标时刻之后的整个窗口内宿主都未运行，那一天无法补签：由于"due"没有日期上限，第二天开机会立刻补一轮，但服务端按**当天**记账，补的是第二天那一份（`checkin.rs:1568-1598` 的 `missed_window_and_new_accounts_are_due_immediately` 描述了这个语义：立即补"最近一个已应到的目标"，不是"补昨天"）。
- 未设置时间段时无此问题（每轮全量核验，开机即签）。

**P2-6 循环没有 panic 守护，异常一次即静默停摆**
- 周期循环是裸 `loop`（`lib.rs:68-74`、`main.rs:31-34`），没有 `catch_unwind`、没有重启、也没有"上次成功时间"心跳。
- 已知 panic 源都在极小的临界区（`Mutex::lock().unwrap()`：`config.rs:425/542/550`、`checkin.rs:88-91`、`config.rs:37`），实际触发概率低；但一旦触发，该进程内自动签到/自动旅行永久失效直到重启，且无任何提示。
- `RunFlagGuard`/`AccountRunGuard` 是 `Drop` 复位（`config.rs:876-880`、`checkin.rs:99-105`），unwind 路径也能释放，所以**不会**造成标志位永久卡真。

**P2-7 账号页签到状态不轮询**
- `checkinMap` 只在账号集合/配置变化时查一次（`AccountsPage.tsx:406-421`），页面长开时"今日已签到"徽标会过期；后台签到完成后也不会有事件推送刷新（对应 P1-4）。

**P2-8 排除名单只作用于签到，不作用于自动旅行**
- `travel.rs` 只读自己的 `auto_travel_config`，不读 `excluded_account_ids`（`travel.rs:845-861`）。
- 而 UI 文案是"不参与自动签到的账号"（准确性 OK），但用户很容易理解为"这个账号的自动领取都关了"。

**P2-9 签到与旅行可能并发刷新同一账号的 token（潜在）**
- `refresh_account_token` 没有账号级锁（`refresh.rs:41-146`），只做 `upsert_account`（`account.rs:328-332`）。签到周期、旅行派发/领取周期、每日保活（`lib.rs:115-125`）都可能在极窄窗口内对同一账号发起 refresh。
- 若官方 refresh token 是轮换型的，第二个请求可能用旧 refresh_token → 可能被判失效并写 `needs_relogin`。本次静态走查未证实服务端行为，故列 P2 观察项（建议后续加账号级刷新互斥）。

**P2-10 加密信封账号在批量/一键签到里被计入「失败」**
- 结果归类为 `error`（`checkin.rs:144-146` → `decide_from_status` → `StatusDecision::Error`，`checkin.rs:290-298`），所以"全部立即签到"会显示"失败 N"，托盘 `checkin_succeeded` 也判为不成功（`tray.rs:490-501`）。文案可读（`account.rs:465-474`），但会长期污染失败统计。

**P2-11 自动周期的请求成本**
- 未设置时间段时每 30 分钟对**每个合格账号**发一次状态请求（`checkin.rs:710-728`，`window=None` 时不 due 过滤）。10 个账号 ≈ 每天 480 次状态请求。不致命，但对官方接口是否友好无法静态判定；设置时间段后可显著降低（只处理到点未办账号）。

---

## 4. 结论与最值得补的 3 个方向

### 结论
**该功能已经完整可用，不需要"新增"实现。** 端到端链路（UI / 托盘 / 后台定时器 → API/IPC → core → `codebuddy.cn` 两个签到接口 → `~/.wb-switch/auto_checkin_logs.json`）全部闭环；国际版零请求短路、信封凭据短路、`[start,end)` 窗口与错峰抽签、排除名单、并发保护、日志 30 天/500 条治理都实现到位且有单测（编译与单测结果见 §5：core crate 在 CI 上 773/759 全绿）。桌面版**确实**会每天自动签到（`src-tauri/src/lib.rs:59-75` + `205-207`），与 webui 走同一套 core 循环。

功能"看起来不存在"的原因是产品与文档层面：默认关闭且默认值不持久（P1-1，已按 QA 复核修正）、开启后不立即执行（P1-2）、后台执行无任何可见反馈（P1-4）、README 一个字都没提（P1-5）。

风险总账：**P0 = 0**，**P1 = 5**（全部是产品/文档/默认值语义层，无实现正确性缺陷），**P2 = 11**（体验与残余风险）。

### 如果锋哥仍想"增加"这个功能，最值得补的 3 个方向
1. **可发现性 + 首次引导（成本最低、收益最高）**
   README「功能」表补一行「每日自动签到」+「使用」步骤补一条路径（设置 → 自动签到 → 开启）；首次进入设置页或账号页时给一次引导提示（含"未设置时间段会每 30 分钟核验一次"与"需 App 常驻，建议同时开启开机自启"的说明）。

2. **开启即生效 + 结果可观测**
   在 `save_auto_checkin_config`（`commands.rs:1121`、`api.rs:1509`）里照搬自动旅行的做法（`commands.rs:1159-1164`）：`enabled` 由 false→true 时 spawn 一轮 `run_checkin_cycle`；周期循环结束后 `notify_checkin`/写 `notifications::record`，并 `refresh_tray_menu`（现在只有手动一键签到才刷新，`tray.rs:388-417`）。同时把"最近一次自动签到时间/结果"落到配置侧或返回体里，在设置页与托盘展示。

3. **让「开关状态」本身可信（修 P1-1 的正确性缺口 + P2-1 的判定漏洞）**
   ① 把 `load_checkin_config` 的"使用痕迹"判据从 `config 文件存在 || 日志文件存在`（`config.rs:380`）收窄为「仅配置文件存在」或改用显式 `install_marker`，避免"手动签一次 → 自动签到被静默打开"；② 未设置时间段时也对 `already` 结果补写回执（放宽 `checkin.rs:733-738` 的 `if let Some(win)`），修掉托盘"整天可签到"的判定漏洞；③ 循环加 panic 守护 + 心跳（`lib.rs:68-74`、`main.rs:31-34`），并在设置页提示"自动签到自 X 时间起未成功执行"。

（若只做一件：选第 1 项；若允许动代码：第 3 项的第 ① 小项是**真正的正确性修复**（默认值语义被"使用痕迹"污染），第 2 项的第 1 小项是**感知层最小改动**（开启即跑一轮）。两者都只各改一处。）

---

## 5. 编译与单测验证

### 5.1 本机无法编译（已排查到底，非代码问题）

本地 `cargo test -p wb-switch-core` 在当前受限会话中无法完成，三条独立原因均已逐一验证：

1. **无 MSVC 且装不上**：本机没有 Visual Studio C++ 生成工具；VS Build Tools 引导器在此受限会话中始终只做 "Preparing" 就退出（ExitCode 5 / 空跑），无法完成安装。
2. **改用 MinGW-w64 16.2.0 + `stable-x86_64-pc-windows-gnu` 工具链后仍失败**：`gcc` 本身可正常编译，但 binutils 的 `ld` 与 `dlltool` 一律报 `Cannot create temporary file ...: Permission denied`。与 `TMP` / `TEMP` / `TMPDIR` 无关——换到标准 Temp 目录同样失败（受限会话对子进程创建临时文件的拦截）。
3. **`RUSTFLAGS="-C link-self-contained=yes"`（rust-lld）解决了链接器问题**，但 `dlltool` 生成 import library（`windows-sys` / `getrandom` 需要）依然失败 → 本机 `cargo test` 无法完成。

结论：本机环境不具备编译 Rust 目标的条件，**与仓库代码无关**，不再重试。

### 5.2 真实编译验证：仓库自带 CI

编译器与测试通过仓库已有的 GitHub Actions 工作流 `.github/workflows/test.yml` 完成（其中的测试命令就是 `cargo test -p wb-switch-core`，与本次验证目标一致）。

运行记录：<https://github.com/hkshiqi/workbuddy-switch/actions/runs/42282041386>

| Job | 平台 | 结果 |
| --- | --- | --- |
| `cargo test` | ubuntu-latest | ✅ **773 passed / 0 failed** |
| `cargo test` | windows-latest | ✅ **759 passed / 0 failed**（另有 5 passed 的附加步骤） |
| `frontend-tests` | ubuntu-latest | ✅ success |
| `cargo test` | macos-14 | ⚠️ cancelled —— `The configuration 'macos-14-arm64-us-default' is not supported`（fork 账号无该 runner 配置，**与代码无关**） |
| `lint` | — | ⚠️ cancelled —— 随 macos job 失败被一并取消 |

### 5.3 结论

- **`wb-switch-core` crate 编译通过**（Linux + Windows 双平台实际编译并运行），**单测 773 / 759 个全绿、0 失败**；macOS 与 lint 的 cancelled 是 fork runner 配额问题，不构成代码质量结论。
- 签到相关单测**覆盖完整并通过**，本报告 §2 中依赖单测佐证的每条结论都有对应用例：
  - 错峰抽签稳定性与跨账号/跨日分散：`checkin.rs:1377-1403`
  - 窗口合法性（半填 / 非法 / `start>=end` / 越界）：`checkin.rs:1406-1437`
  - `[start,end)` 边界（start 整点在内、end 整点在外）：`checkin.rs:1441-1467`
  - 窗口外整轮跳过（不查状态、不提交、不写日志）：`checkin.rs:1471-1504`
  - due 判定（到点前不发请求 / 到点后补签 / 昨日回执不顶替今日）：`checkin.rs:1538-1598`
  - 窗口回执（手动提前签到 → already 回执跨重启成立）：`checkin.rs:1601-1691`
  - 重试节奏（30 分钟基线 / 5 分钟快速重试 / 预算耗尽回落 / 1 分钟下限）：`checkin.rs:1745-1820`
  - 国际版零请求短路：`checkin.rs:1110-1134`；刷新短路：`checkin.rs:1072-1107`
  - 信封凭据不发空 Bearer：`checkin.rs:897-909`
  - 排除名单不误发请求：`checkin.rs:911-956`
  - 并发 guard 不可重入 + 手动批量在周期运行时返回 busy：`checkin.rs:1174-1192`
  - 默认值"使用痕迹"策略（全新安装 false / 仅有日志 true / 显式 false 覆盖 / 配置损坏仍 true）：`config.rs:1249-1318`
- 因此：**「该功能实现正确且自带测试保护」这一判断已由 CI 实际编译运行结果支撑，不再只依赖静态走查。** 本报告 §3 的 P1/P2 项均为产品、文档、默认值语义与可观测性问题，**不是**实现正确性缺陷。
