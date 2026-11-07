# 签到功能全链路走查报告（v0.1.62 / 22b318c）

> 任务：验证「每天自动签到领积分」是否已完整可用、有无缺口。
> 方式：纯静态走查（未修改任何业务代码）+ 编译与单测结果取自仓库 CI（见 §5）。
> 结论先行：**功能已完整可用（端到端闭环，无 P0 阻断）**；用户「以为没有这个功能」的直接原因是**默认关闭且默认值不持久 + 文档完全没写 + 后台执行无反馈**，而不是实现缺失。
> 修订记录：
> - R1（QA 一次复核）：§3 P1-1 修正为「默认关闭不持久」（触发条件 = 日志文件存在而配置文件缺失），原 P1-1 后半拆为 P1-2，P1 总数 4→5；新增 §5 编译与单测验证。
> - R2（QA 二次复核）：P1-1「后果 2」改为**当场翻转**（`SettingsPage.tsx:569` 的 `loadConfig()`，非"下次挂载"）；P1-2 增加"不要把「全部立即签到」当缓解手段"的警告；新增 P2-12（当天最后一次失败把托盘判定打回未签）；§5.2/§5.3 **收窄 CI 覆盖范围**为"仅 core @ ubuntu+windows，宿主 crate 无 CI 测试证据"。
> - **R3（修复落地，与本文档同批提交）**：本报告 §3 中 **P1-1、P1-2、P1-5、P2-1、P2-6、P2-12 已修**，逐条状态见各小节首行的「**状态**」。行为变更（默认值判据收窄）单独写在 [`CHECKIN-BEHAVIOR-CHANGE.md`](./CHECKIN-BEHAVIOR-CHANGE.md)，升级影响与重新开启方式在那里。**R2 中"不要把「全部立即签到」写进引导"的警告已随 P1-1 的根因修复失效**（写日志不再影响 `enabled`），已在 P1-2 与 §4 中移除。
> - 仍未修：**P1-3**（App 常驻未联动提示）、**P1-4**（后台结果不可见，仅补了心跳可观测性）。**P1-2** 与 **P2-1 的"手动/批量 `already` 不写回执"那一半**已在同一轮补齐（P1-2 = 保存配置 false→true 时 spawn 一轮，两端均改；P2-1 = `checkin_account` 的 already 分支补回执）。
> - **R4（P1-3 + P1-4 落地）**：上一条里的两个遗留项已修，逐条状态见各小节首行。后台轮次现在有结果出口（托盘刷新 + `checkin-round-finished` 事件 + 系统通知，均带通知门槛），启动设置里对「关了开机自启却开着后台功能」给出常驻提示。同时补了 CI 兜底门禁 `desktop-gate`——`lint` 绑在 `macos-14` 上，拿不到该 runner 的环境（含本 fork）会被直接取消，导致 fmt / clippy / `wb-switch-server` / `wb-switch-rust` 测试**一次都不执行**，§5 的覆盖范围由此收窄过。

---

## 0. 目录

1. [端到端调用链表](#1-端到端调用链表)
2. [已闭环清单（含证据）](#2-已闭环清单含证据)
3. [缺口 / 风险清单](#3-缺口--风险清单)
4. [结论与最值得补的 3 个方向](#4-结论与最值得补的-3-个方向)
5. [编译与单测验证](#5-编译与单测验证)
6. [手工验收清单（CI 覆盖不到的部分）](#6-手工验收清单ci-覆盖不到的部分)

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
- 启动默认值策略：全新安装 `enabled:false`；**已有安装的判据 = 仅配置文件存在**（`config.rs` 的 `load_checkin_config_at`，`existing_install = config_path.exists()`），配置文件存在但没有 `enabled` 字段或内容损坏时沿用历史默认 `enabled:true`。**签到日志不再参与该判据**（R3 前的旧判据是 `config || logs`）。读取结果附带派生字段 `enabled_source`（`user` / `legacy_config` / `default`，**只读不落盘**），设置页据此标注「当前为自动启用」。
  > 状态：**已修（P1-1 根因）**。变更说明与升级影响见 [`CHECKIN-BEHAVIOR-CHANGE.md`](./CHECKIN-BEHAVIOR-CHANGE.md)；单测 `load_checkin_config_only_treats_config_file_as_usage_trace`、`save_checkin_config_never_persists_enabled_source`。

### 2.9 派猫猫旅行（自动领积分）不干扰签到
- 独立配置 `auto_travel_config.json`、独立缓存、独立并发标志（`config.rs:89-95`、`travel.rs:23-24`）、独立周期（30 分钟派发 / 15 分钟领取，`travel.rs:43-45`）、独立档位门控（仅 Cn，`variant.rs:310-312`、`travel.rs:35-41`、`857-861`）。
- UI 上确实是**同一张设置卡片内的一行**（`SettingsPage.tsx:755` `<AutoTravelRow/>` 渲染在自动签到卡片内；`SettingsPage.tsx:816-871`），但配置与执行完全解耦，互不覆盖。
- 开关联动：旅行开启时会立即跑一轮派发+领取（`commands.rs:1156-1166`、`api.rs:1541-1556`）；签到**已对齐**该语义——保存配置 `enabled` 由 false→true 时两端各 spawn 一轮（见 §3 P1-2）。

### 2.10 前端口径一致
- 档位能力前端唯一来源 `src/lib/variant.ts`，与后端 `variant.rs` 同口径（`cn` 才支持签到/旅行）。
- 账号元数据一定带 `variant`（后端 `account_meta` 用 `variant_of` 计算，`account.rs:147-149`），因此前端 `accountVariant`（只看 `account.variant`）不会与后端"域名兜底"产生分歧。
- 设置页时间段校验与后端语义一致：半填/非法/`start>=end` 只在本地显示、不落盘并给出"未保存"文案（`SettingsPage.tsx:296-304`、`497-529`）；落盘采用串行提交链避免并发覆盖（`SettingsPage.tsx:436-466`）。

---

## 3. 缺口 / 风险清单

### P0 阻断
**无。** 未发现导致功能不可用或数据损坏的缺陷。

### P1 明显缺陷（影响"用户感知到功能存在且生效"）

**P1-1 默认关闭不持久：任意一次手动签到就会把「自动签到」静默打开（设置页开关会当场跳到"开"，账号页则停留在旧值）**
> **状态：已修（R3）。** 采用下方建议 ①+② 的组合：② 把"使用痕迹"判据收窄为「仅配置文件存在」（根因修复），① 同时下发派生字段 `enabled_source` 供设置页标注来源（可追溯）。**因此本节描述的"点一次手动签到 → 下次读配置时开关跳到开"链路已不再成立**——写日志不再影响 `enabled`。原文保留作为问题记录；行为变更与升级影响见 [`CHECKIN-BEHAVIOR-CHANGE.md`](./CHECKIN-BEHAVIOR-CHANGE.md)。
>
> **本节为 QA 独立复核后的修正版（二次修订）**：原表述为「全新安装默认关闭」，方向正确但**不完整**。QA 复核提出「默认关闭不持久、UI 显示与实际行为不一致」，经逐行核对 `load_checkin_config` / `default_checkin_config` / `save_checkin_config` 后确认 **QA 的定性成立**。本节给出精确的触发条件与重复路径；其中「UI 与行为不一致」的复现强度以及 §5 的 CI 覆盖范围，均由 QA 的二次复核进一步收窄（见下方"后果 2"与 §5.3 的限定说明）。

- **全新安装（两个文件都不存在）→ `enabled` 确实是 `false`。** `load_checkin_config()` → `load_checkin_config_at()`（`config.rs:376-381`）以 `existing_install = config 文件存在 || 日志文件存在` 作为判据，两者皆无时走 `default_checkin_config()`（`config.rs:280-282`）→ `enabled:false`。单测直接断言该行为：`config.rs:1281-1287`。
- **但 `enabled` 的默认值不是常量，而是由「使用痕迹」决定。** 判据一旦命中（`config.rs:380`），基线换成 `legacy_default_checkin_config()`（`config.rs:285-287`）→ **`enabled:true`**。单测明确断言「只有签到日志、没有配置文件」时 `enabled=true`：`config.rs:1289-1296`；配置文件存在但内容损坏时同样 `true`：`config.rs:1307-1315`。
- **日志文件不需要开启自动签到就会被创建。** 写日志的唯一主动入口是 `checkin_account` 的提交分支（`checkin.rs:373`，`add_checkin_log`），而批量签到的公开入口 `run_checkin_all` **不检查 `enabled`**（`checkin.rs:851-867`；只有 `run_checkin_cycle` 在 `checkin.rs:706-709` 检查）。因此触发链是：**全新安装 → 用户点一次「签到」/「全部立即签到」/托盘「一键签到」/账号页「刷新并签到」→ `~/.wb-switch/auto_checkin_logs.json` 落盘 → 下一次 `load_checkin_config()` 起 `enabled` 变为 `true`**。
- 后果 1（状态污染）：用户从没拨过开关，设置页重新加载后显示"开启"。这是不可归因的静默翻转。
- 后果 1b（行为侧）：后台循环每轮都重新 `load_checkin_config()`（`checkin.rs:706`），因此自日志落盘后的下一轮起，自动签到即以"已开启"执行、每 30 分钟一轮，无需任何用户操作。
- 后果 2（**UI 与行为不一致，即 QA 指出的现象；二次复核后确认比原描述更严重**）：
  - **设置页是「当场翻转」，不是"下次挂载才变"**：`checkinAllNow()` 在 `try` 尾部直接 `void loadConfig()`（`SettingsPage.tsx:569`），`loadConfig` → `get_auto_checkin_config` → `savedRef.current = loaded` + `adoptSaved(next)`（`SettingsPage.tsx:404-412`、`421-428`）；此时后端已因日志文件存在而返回 `enabled:true`，于是**开关在同一屏内从"关"跳到"开"，用户全程没碰过开关**。前提是本次至少有一个账号真正走到提交（`success` 或 `error` 都写日志）；若全是 `already`，`checkin.rs:321` 提前 return 不写日志，则不翻转。
  - **账号页才是"挂载读一次"**：`AccountsPage.tsx:292-308` 的 effect 依赖数组是 `[]`，日志落盘后不重读 → 该页的"自动签到已关闭"chip 与状态查询跳过逻辑会停留在旧值。
  - 最刺眼的自相矛盾：**触发这次翻转的按钮「全部立即签到」（`SettingsPage.tsx:543`、`635-639`）正是 P1-2 里推荐的缓解入口**——即"文档让你点它、它顺手把开关打开"。P1-2 的缓解建议已据此改写。
- 一次性 vs 持续：只要用户显式保存过一次配置（哪怕只是拨一下开关再拨回来），`{"enabled": false}` 落盘后就会永久覆盖痕迹（`config.rs:1299-1305` 单测）。所以这是「首次手动签到后的一次静默翻转」，不是每次都发生。
- 定级理由：不与 P0 冲突（不会误签他人账号、不会损坏数据、签到本身幂等），但它破坏了"默认关闭"这个安全默认值的语义，且用户无法从 UI 追溯原因，故列 P1。
- 建议修法（按风险从低到高，**①② 已落地**）：
  ① ✅ **【已落地】来源可追溯**：API 同时返回 `enabled` 的来源（`enabled_source`：显式保存 / 旧配置回落 / 全新默认），设置页在开关旁标注「当前为自动启用：**检测到旧版或损坏的配置文件**，非你手动开启」——把"不可追溯"消掉，且不动调度语义。（注：文案不能说"检测到历史签到记录"，判据里已经没有日志了。）
  ② ✅ **【已落地，根因修复】** 使用痕迹判据从 `config || logs` 收窄为「仅配置文件存在」，与 ① 同批下发；升级影响通过 [`CHECKIN-BEHAVIOR-CHANGE.md`](./CHECKIN-BEHAVIOR-CHANGE.md) 说明（等价于 release note）。
  ③ 未采用（② 已让本条失去必要性）：让手动签到写独立日志文件。
  ④ 已做（R4，见 P1-4）：每轮把结果推出去（托盘刷新 + `checkin-round-finished` 事件 + 系统通知，带通知门槛），不再只剩「心跳文件 + 设置页展示」这一层。

**P1-2 开启后不立即执行 → 用户"开了却没反应"**
> **状态：✅ 已修（R3）。** `save_auto_checkin_config`（Tauri `commands.rs`）与 `POST /api/checkin/config`（HTTP `api.rs`）现在会在 `enabled` **由 false 变 true** 时 `spawn` 一轮 `run_checkin_cycle(CheckinCycleMode::PeriodicRecovery)`——与自动旅行的保存语义一致。只在 false→true 触发：修改签到时间段 / 排除名单走同一保存入口，不会白跑请求。并发由 `RunFlagGuard` 兜底（抢不到锁返回 `already_running`），无需额外防重入。README「使用」第 8 条已写明"开启后立即执行一轮"。**R2 的 ⚠️ 警告已失效**——P1-1 根因修复后写日志不再翻转 `enabled`。
- 修复前：保存配置只落盘、不触发任何一轮签到，用户最长等 30 分钟（`next_cycle_delay` 的 clamp 上限），期间关掉 App 则什么都不发生。
- 残余（R4 已修）：开启那一轮的结果现在会走后台投递通道（托盘刷新 + toast + 系统通知），不再只停留在设置页「上一轮」。

**P1-3 「每天自动」的前置条件（App 常驻 / 开机自启）既未提示也未联动**
> **状态：已修（R4）。** 启动设置卡片（`SettingsPage.tsx` 的 `StartupCard`）现在会读自动签到 / 自动旅行配置：开关处于关闭态且其中任一开着时，行下方常驻一行琥珀色提示「只有你当天手动打开过 App 才会执行」；关掉开关的瞬间 toast 也从「已关闭」换成带后果说明的警告。判定与文案都在前端，后端不变——它无法知道用户"想不想常驻"。
- 自动签到依赖宿主进程常驻：`lib.rs:59-75`（桌面）/ `main.rs:25-35`（CLI）。开机自启是**另一个独立卡片**、系统级 opt-in（`SettingsPage.tsx:1477+`、`commands.rs:1321-1333`），二者没有任何交叉提示。
- 时间段说明里只有一句"需 App 在窗口附近运行才能按时执行"（`SettingsPage.tsx:650`），未覆盖"未设置时间段时也要 App 在跑"和"建议开启开机自启"。
- 影响：用户设好就关掉 App，第二天发现没签，归因为"功能不存在 / 坏了"。
- 残余：webui 形态下没有「开机自启」这个概念（`launch-at-login` 仅桌面端注册），该提示只在桌面端出现——这是对的，不是遗漏。

**P1-4 后台自动签到结果对用户完全不可见（无通知、无托盘刷新）**
> **状态：已修（R4）。** `run_checkin_round` 的返回值不再被丢弃：
> - 托盘：`tray::announce_checkin_round` 在「真有账号刚被签上」时重建菜单——只在可能翻转时重建，因为无谓 `set_menu` 会让用户正打开的菜单闪掉；标签随即变成「已签到」。
> - 应用内：每轮推 `checkin-round-finished`（`message` / `level` / `signed` / `already` / `failed`），窗口开着时由 `useCheckinRoundNotice` 弹 toast。
> - 系统通知：窗口没开时唯一可见的通道，与上一条并存（开发态通知会登记到「终端」名下，且投递失败不可观测，所以两者都发、以应用内为准）。
> - 通知门槛 `checkin_notify_level`：只有「刚签上」与「刚开始出错」才提示。稳态轮次（当天已签 → 全 `already`、未到点、未启用）一律不弹，否则每 30 分钟一条立刻变骚扰；持续失败只提示一次（`deliver_checkin_notify` 跨轮传 `previous_had_errors`），恢复后再次失败会重新提示；`panic` / `aborted` 没有账号行但按失败提示——守护把异常吞掉了，再没人提就等于静默。
> - 保存配置触发的那一轮也投递（`save_auto_checkin_config` 收 `AppHandle`）：用户刚打开开关就盯着页面，「签上了没有」正是他最想知道的。
> - 旅行只提示「领取」（`claimed > 0`）：派发轮是当天例行簿记，每天一条「已派出」只会稀释真正有用的消息。
- 两宿主的周期循环都丢弃返回值：`let _ = run_checkin_cycle(...)`（`lib.rs:65-74`、`main.rs:30-33`），不弹通知、不写 `notifications`（`notifications::record` 只被前端 toast 和 API 调用，`commands.rs:1450-1455`、`api.rs:1677-1689`；core 的 checkin/travel 都没有调用点）。
- 托盘菜单标签"已签到/一键签到"只在 `build_tray_menu` 时计算（`tray.rs:619-638`），且只在轻量模式切换、`CheckinBusyGuard` 起止时重建（`tray.rs:318-366`、`377-386`）——后台自动签到完成**不会**刷新托盘，标签会长期停留在"一键签到"。
- 唯一可观测物是设置页的签到日志（懒加载、需手动展开，`SettingsPage.tsx:394-402`、`757-803`）。
- 残余（R4 后）：账号卡上的「今日已签」徽标仍不会随后台签到自动变色——`checkinMap` 只在账号集合 / 配置变化时查一次（`AccountsPage.tsx:406-421`）。事件通道已经就位，接上它只是再调一次 `checkinMap`，本轮没做（需要确认是否会与卡片本地计数冲突）。

**P1-5 README 完全没有签到 / 旅行**
> **状态：已修（R3）。** README「功能」表已补「每日自动签到（含派猫猫旅行）」一行，「使用」步骤已补一条路径（设置 → 自动签到 → 开启，并写明需 App 常驻、建议同时开启开机自启）。
- （原文）「功能」表与「使用」步骤均未出现"签到""旅行"字样。功能表里连"积分到期查询"都有，却没有"每日自动签到"。
- 影响：这是"用户以为需要新增该功能"的**最直接原因**——功能齐全但不可被发现。

### P2 体验问题 / 残余风险

**P2-1 已签但托盘不显示「已签到」的判定漏洞**
> **状态：✅ 已解决（R3）。** 两侧都补齐了：
> - **自动周期**：`write_window_receipt` 改为**无条件**补写 `already` 回执（窗口生效走 `Some(win)` 的窗口回执语义；`window = None` 时按"今天 00:00 起是否已有 success/already"去重，一天最多一条，不会每 30 分钟重写整份日志）。
> - **手动路径**：`checkin_account` 的 `StatusDecision::Already` 分支现在也调 `write_window_receipt(None, &acc)` 补回执，**返回 payload 保持原样**（仍为 `{"result":"already"}`）。由于单账号签到、一键签到、刷新并签到都汇聚到 `checkin_account`，三条手动入口一次性覆盖。
- （原文）托盘"今天是否全部已签到"依赖当天日志里的 `success/already`。而"到点复核发现服务端已签"时，只有**窗口生效**才补写 `already` 回执。
- （原文）后果：未设置时间段时，若账号已被官方客户端/自己签过，自动周期永远拿到 `already` 但永不落日志 → 托盘整天显示"一键签到"。

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
> **状态：已修（R3）。** 两个宿主的周期循环都改为调用 `checkin::run_checkin_round`：内部用 `tokio::spawn` 把整轮隔离到独立任务，`JoinError::is_panic()` 为真时只记录一条失败心跳（含截断到 300 字符的 panic 原因）并返回 `{status:"panic"}`，**循环继续**。心跳落盘到 `~/.wb-switch/checkin_heartbeat.json`，每轮结束（含 `disabled` / `no_accounts` / `before_checkin_time` 各早退路径）都写；设置页展示「上一轮」并在**连续 ≥2 轮 panic** 时提示「已连续 N 轮异常，请重启应用」（锁中毒后每轮都会 panic，只能重启）。零新增依赖（`tokio` 已是既有依赖）。
> 边界：守卫的是"循环不停"，不是"问题自愈"；panic 发生在**持锁期间**时 Mutex 会中毒，后续每轮仍在同一处 panic——这正是连续计数存在的意义。
- （原文）周期循环是裸 `loop`，没有 `catch_unwind`、没有重启、也没有"上次成功时间"心跳；一旦 panic，该进程内自动签到/自动旅行永久失效直到重启，且无任何提示。
- 已知 panic 源都在极小的临界区（`Mutex::lock().unwrap()`），实际触发概率低。
- `RunFlagGuard`/`AccountRunGuard` 是 `Drop` 复位，unwind 路径也能释放，所以**不会**造成标志位永久卡真。

**P2-7 账号页签到状态不轮询**
- `checkinMap` 只在账号集合/配置变化时查一次（`AccountsPage.tsx:406-421`），页面长开时"今日已签到"徽标会过期；后台签到完成后也不会自动刷新——（R4 后）事件通道 `checkin-round-finished` 已经就位，接上它只是再调一次 `checkinMap`，本轮未做（需确认是否与卡片本地计数冲突）。

**P2-8 排除名单只作用于签到，不作用于自动旅行**
- `travel.rs` 只读自己的 `auto_travel_config`，不读 `excluded_account_ids`（`travel.rs:845-861`）。
- 而 UI 文案是"不参与自动签到的账号"（准确性 OK），但用户很容易理解为"这个账号的自动领取都关了"。

**P2-9 签到与旅行可能并发刷新同一账号的 token（潜在）**
- `refresh_account_token` 没有账号级锁（`refresh.rs:41-146`），只做 `upsert_account`（`account.rs:328-332`）。签到周期、旅行派发/领取周期、每日保活（`lib.rs:115-125`）都可能在极窄窗口内对同一账号发起 refresh。
- 若官方 refresh token 是轮换型的，第二个请求可能用旧 refresh_token → 可能被判失效并写 `needs_relogin`。本次静态走查未证实服务端行为，故列 P2 观察项（建议后续加账号级刷新互斥）。

**P2-10 加密信封账号在批量/一键签到里被计入「失败」**
- 结果归类为 `error`（`checkin.rs:144-146` → `decide_from_status` → `StatusDecision::Error`，`checkin.rs:290-298`），所以"全部立即签到"会显示"失败 N"，托盘 `checkin_succeeded` 也判为不成功（`tray.rs:490-501`）。文案可读（`account.rs:465-474`），但会长期污染失败统计。

**P2-11 自动周期的请求成本**
- 未设置时间段时每 30 分钟对**每个合格账号**发一次状态请求（`window=None` 时不 due 过滤）。10 个账号 ≈ 每天 480 次状态请求。不致命，但对官方接口是否友好无法静态判定；设置时间段后可显著降低（只处理到点未办账号）。
- 写盘成本不随请求数放大：`already` 回执在 `window=None` 时按"今天 00:00 起是否已有 success/already"去重（`receipt_needed`），一天每账号最多写一条；此前若按"无条件补写"实现，10 个账号会变成每天约 480 次整份日志读取 + 写入。

**P2-12 「当天最后一次失败」会把托盘判定从「已签到」打回「一键签到」（与窗口回执口径不一致）**
> 本条由 QA 复核提出（F2），已并入。
> **状态：已修（R3）。** `latest_today_result` 已删除，改为 `today_answered`：**当天任意一条 `success` / `already` 即算已签**，`error` 只用于展示与失败重试预算。原先把"最后一条失败即判未签"固定为预期的单测 `checked_in_today_false_when_one_failed_last` **已随行为变更反转**为 `checked_in_today_true_when_any_success_even_if_a_later_attempt_failed`（断言：早上 success + 下午 error → 仍判已签）。
- （原文）托盘"今天是否全部已签到"取的是**当天最后一条**日志，因此"早上 success、下午一次手动签到失败写入 `error`"会把当天判定打回未签到。
- （原文）这与窗口回执用的 `logs_answered_window`（"窗口内任意一条 success/already 即算已回应"）**口径不一致**，两处对"当天签到成功"的定义不同。

---

## 4. 结论与最值得补的 3 个方向

### 结论
**该功能已经完整可用，不需要"新增"实现。** 端到端链路（UI / 托盘 / 后台定时器 → API/IPC → core → `codebuddy.cn` 两个签到接口 → `~/.wb-switch/auto_checkin_logs.json`）全部闭环；国际版零请求短路、信封凭据短路、`[start,end)` 窗口与错峰抽签、排除名单、并发保护、日志 30 天/500 条治理都实现到位且有单测（编译与单测结果见 §5：**`wb-switch-core` 在 CI 的 ubuntu/windows 上 773/759 全绿**；宿主 crate 无 CI 测试证据，见 §5.3 的限定）。桌面版**确实**会每天自动签到（`src-tauri/src/lib.rs:59-75` + `205-207`），与 webui 走同一套 core 循环。

功能"看起来不存在"的原因是产品与文档层面：默认关闭且默认值不持久（P1-1，**【R3 已修】**：判据收窄 + 来源标注）、开启后不立即执行（P1-2，**【R3 已修】**：保存配置 false→true 时立即跑一轮）、后台执行无任何可见反馈（P1-4，**【R4 已修】**：托盘刷新 + 事件 toast + 系统通知）、README 一个字都没提（P1-5，**【R3 已修】**）。

风险总账：**P0 = 0**，**P1 = 5**（全部是产品/文档/默认值语义层，无实现正确性缺陷；R3 修掉 P1-1 与 P1-5），**P2 = 12**（体验与残余风险；R3 修掉 P2-6 与 P2-12，部分解决 P2-1）。
> R3 修复批次的行为变更（默认值判据收窄）单独成文：[`CHECKIN-BEHAVIOR-CHANGE.md`](./CHECKIN-BEHAVIOR-CHANGE.md)。

### 如果锋哥仍想"增加"这个功能，最值得补的 3 个方向

> **R3 进度**：第 1 项（可发现性）的 README 部分**已完成**；第 3 项的 ①②③④ **全部完成**（P2-1 只做了 ③ 的"自动周期补写"那一半）。**剩余**：第 1 项的首次引导提示、第 2 项整项（开启即跑一轮 + 后台结果通知）。

1. **可发现性 + 首次引导（成本最低、收益最高）**
   ✅ README「功能」表已补一行「每日自动签到（含派猫猫旅行）」+「使用」步骤已补一条路径（设置 → 自动签到 → 开启，含"需 App 常驻，建议同时开启开机自启"）。
   ⬜ 未做：首次进入设置页/账号页的引导提示（含"未设置时间段会每 30 分钟核验一次"）。
   注：R3 之前此处有"引导里不要把「全部立即签到」写成替代操作"的 ⚠️，已随 P1-1 根因修复失效并移除——写日志不再翻转 `enabled`。

2. **开启即生效 + 结果可观测（未做）**
   在 `save_auto_checkin_config` 里照搬自动旅行的做法：`enabled` 由 false→true 时 spawn 一轮签到；周期循环结束后弹通知 + `refresh_tray_menu`。部分替代：R3 的心跳已让设置页能看到「上一轮」，但托盘与通知仍未联动。

3. **让「开关状态」本身可信（①②③④ 全部已落地）**
   ① ✅ 配置接口返回 `enabled` 的来源（`enabled_source`），设置页在开关旁标注「当前为自动启用：检测到旧版或损坏的配置文件，非你手动开启」；
   ② ✅ `load_checkin_config` 的"使用痕迹"判据收窄为「仅配置文件存在」，升级影响见 [`CHECKIN-BEHAVIOR-CHANGE.md`](./CHECKIN-BEHAVIOR-CHANGE.md)（等价 release note）；
   ③ ✅ 未设置时间段时也对 `already` 补写回执（按天去重），并把 P2-12 的口径统一为"当天任意 success/already 即算已签"；
   ④ ✅ 循环加 panic 守护 + 心跳，设置页提示「上一轮」与连续 panic 次数（超过 2 小时未更新会高亮）。

（R3 之后若只做一件：第 2 项「开启即跑一轮」——它补的是"开关了却要等 30 分钟"这段最容易被感知为空转的空窗。）

---

## 5. 编译与单测验证

### 5.1 本机无法编译（已排查到底，非代码问题）

本地 `cargo test -p wb-switch-core` 在当前受限会话中无法完成，三条独立原因均已逐一验证：

1. **无 MSVC 且装不上**：本机没有 Visual Studio C++ 生成工具；VS Build Tools 引导器在此受限会话中始终只做 "Preparing" 就退出（ExitCode 5 / 空跑），无法完成安装。
2. **改用 MinGW-w64 16.2.0 + `stable-x86_64-pc-windows-gnu` 工具链后仍失败**：`gcc` 本身可正常编译，但 binutils 的 `ld` 与 `dlltool` 一律报 `Cannot create temporary file ...: Permission denied`。与 `TMP` / `TEMP` / `TMPDIR` 无关——换到标准 Temp 目录同样失败（受限会话对子进程创建临时文件的拦截）。
3. **`RUSTFLAGS="-C link-self-contained=yes"`（rust-lld）解决了链接器问题**，但 `dlltool` 生成 import library（`windows-sys` / `getrandom` 需要）依然失败 → 本机 `cargo test` 无法完成。

结论：本机环境不具备编译 Rust 目标的条件，**与仓库代码无关**，不再重试。

### 5.2 真实编译验证：仓库自带 CI

编译器与测试通过仓库已有的 GitHub Actions 工作流 `.github/workflows/test.yml` 完成。

运行记录：<https://github.com/hkshiqi/workbuddy-switch/actions/runs/42315373466>（R4）

> 下表是 **R4 的实测结果**（全链路：core + server + `src-tauri` + 前端）。R4 新增了 `desktop-gate` job，第一次让 `wb-switch-rust`（`src-tauri`）在 Windows 上被真正编译与测试——此前它连编译证据都没有。本机仍无法编译 Rust（见 §5.1）。

| Job | 平台 | 跑什么 | 结果 |
| --- | --- | --- | --- |
| `rust-tests` | ubuntu-latest | `cargo test -p wb-switch-core` + `clippy -p core -p server`（linux cfg） | ✅ **779 passed / 0 failed** |
| `rust-tests` | windows-latest | `cargo test -p wb-switch-core` | ✅ **765 passed / 0 failed** + 另 5 passed |
| `rust-tests` | macos-14 | `cargo test -p wb-switch-core` | ⚠️ **cancelled** —— `The configuration 'macos-14-arm64-us-default' is not supported`（fork 账号无该 runner 配置，**与代码无关**） |
| **`desktop-gate`（R4 新增）** | **windows-latest** | `cargo fmt --check` + `cargo test -p wb-switch-server` + `cargo test -p wb-switch-rust` | ✅ **server 9 passed / desktop 38 passed，0 failed** |
| `lint` | macos-14 | `tsc` + `fmt` + `clippy`(core/server/rust) + server/desktop 测试 | ⚠️ **cancelled**（同上，runner 不可用） |
| `frontend-tests` | ubuntu-latest | `npm test` | ✅ **74 passed** |

R4 的 `desktop-gate` 当场抓到一个**既有 bug**，可作「这个门禁为什么必须补」的直接证据：`tray.rs` 的 Windows 专属用例 `taskbar_theme_is_readable_on_windows` 调用了 `taskbar_uses_light_theme()`，但测试模块的 `use super::{...}` 里没有它——该函数是 `#[cfg(windows)]`，无条件导入会在 macOS 上报未使用，于是当初就没加。结果这条用例**在 Windows 上根本编译不过**，而 `wb-switch-rust` 此前没有任何 job 在 Windows 上编译过，问题一直没暴露。修法是给导入加 `#[cfg(windows)]`，R4 一并提交。

覆盖边界（R3 时由 QA 指出，R4 已补掉前两条）：

1. ~~`wb-switch-server` 与 `wb-switch-rust` 的单元测试从未在 CI 跑过~~ → **R4 已解决**：`desktop-gate` 在 windows-latest 上实跑 `cargo test -p wb-switch-server`（9 passed）与 `cargo test -p wb-switch-rust`（38 passed）。`lib.rs` / `tray.rs` / `commands.rs` 这些"签到循环宿主"现在有编译 + 测试执行证据。
2. **macOS 仍无 Rust 证据**：`rust-tests` 的 macos-14 与 `lint` 都因 runner 配置缺失被 cancelled。macOS 专属 `cfg` 分支（托盘图标绘制、`LaunchAgent` 自启）仍只靠静态走查。779 ≠ 765 属平台 `cfg` 分支差异，正常现象。
3. **Windows 侧的 clippy 未设门禁**：`desktop-gate` 关闭了 `RUSTFLAGS=-D warnings`（理由同 `build.yml`：vendor 快照的既有告警会被升成错误），也没跑 clippy——Windows 专属 `cfg` 分支的历史告警（core 的 `auth_file` / `codebuddy_cli` / `vscode_cn_inject`）仍然存在，只是不再阻断。`cargo fmt --check` 正常执行。

### 5.3 结论（含覆盖范围限定）

- **`wb-switch-core` 编译通过并跑通单测**：Linux 779 / Windows 765（+5），0 失败。
- **`wb-switch-server` 编译通过并跑通单测**：Windows 9 passed（`desktop-gate`）；另有 ubuntu 侧 `clippy --all-targets` 的编译证据。
- **`wb-switch-rust`（`src-tauri`，含本次改动的 `lib.rs` / `tray.rs` / `commands.rs`）编译通过并跑通单测**：Windows 38 passed，其中包含 R4 新增的 4 条（`background_round_notifies_only_when_something_happened`、`background_round_dedupes_persistent_failures`、`panic_round_counts_as_failure_and_is_explained`、`background_round_message_is_empty_without_results`）。**这是本仓库第一次有机器编译并测试过桌面宿主。**
- **前端**：`tsc` 通过、`vitest` 74 passed。
- **限定 1 —— macOS 仍无证据**：macOS 专属 `cfg` 分支（托盘图标绘制、`LaunchAgent`）仍只靠静态走查。
- **限定 2 —— 真实运行未验证**：以上都是"编译 + 单测"。托盘菜单重建、系统通知投递、toast 实际弹出这三件事都依赖真实窗口环境，CI 无法覆盖，需要在真机上点一遍（§6 给了手工验收清单）。
- 签到相关单测**覆盖完整并通过**，本报告 §2 中依赖单测佐证的每条结论都有对应用例（**行号是 R3 之前的快照**；R3 改动过的文件行号已漂移，以用例名为准）：
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
  - 默认值"使用痕迹"策略（**R3 已改**：全新安装 false / **仅有日志 → false** / 只有配置文件 → true / 显式 false 覆盖 / 配置损坏仍 true）：`config.rs:1249-1318` 的片段已被 `checkin_default_follows_usage_trace`、`load_checkin_config_only_treats_config_file_as_usage_trace` 取代
  - `enabled_source` 三态与"绝不落盘"：`checkin_default_follows_usage_trace`、`save_checkin_config_never_persists_enabled_source`（含真实写盘后断言无该键）
  - 日志上限按时间淘汰（混合 success/already 超量）：`checkin_logs_cap_drops_oldest_rows_regardless_of_result_type`
  - 心跳往返与失败原因截断：`checkin_heartbeat_roundtrips_and_tolerates_missing_files`
  - panic 守护把 panic 翻成失败结果：`guarded_round_converts_panic_into_failure_outcome`（断言 `status == "panic"` / `panicked` / `reason` 含 "panic"，并有正常任务返回 Ok 的对照）
  - 回执去重（窗口内按窗口、`window=None` 按当天）：`receipt_needed_dedupes_per_window_and_per_day`
  - **R3 已反转**："当天最后一条失败即判未签"不再是预期，改为 `checked_in_today_true_when_any_success_even_if_a_later_attempt_failed`（早上 success + 下午 error → 仍判已签，对应 P2-12 的修复）
- 因此准确表述是：**"签到逻辑集中在 core 且 core 有 779/765 个单测保护，编译与测试均已在 ubuntu/windows 实测通过；桌面宿主（`src-tauri`）自 R4 起也有编译 + 单测证据"**；而不是"整个功能已被 CI 全绿背书"（macOS 分支与真实弹窗仍未覆盖，见下）。本报告 §3 的 P1/P2 项均为产品、文档、默认值语义与可观测性问题，**不是** core 的实现正确性缺陷。

---

## 6. 手工验收清单（CI 覆盖不到的部分）

P1-3 / P1-4 改的是「运行时能看到什么」，编译与单测只能证明代码成立，不能证明用户真能看见。以下 5 条需要在真机上点一遍：

| # | 操作 | 期望 |
| --- | --- | --- |
| 1 | 关掉自动签到 → 打开它 | 立即出现「自动签到已开启」，随后（同一次保存触发的后台轮次）再出现一条「自动签到完成：成功 N…」；若账号当天已签，则只有第一条，不弹第二条 |
| 2 | 保持自动签到开启，等到下一个周期（或临时把时间段设到当前分钟后一分钟） | 窗口开着时弹出「自动签到完成」toast；**托盘标签从「一键签到」变成「已签到」**（不需要重新打开菜单） |
| 3 | 把某个账号的 Cookie 改坏，等一轮 | 第一次失败弹「自动签到失败」；**之后每轮不再重复弹**（持续失败只提示一次）；修复后再次失败会重新弹 |
| 4 | 设置页 → 启动设置 → 关闭「开机时静默启动到托盘」（此时自动签到是开的） | toast 变成警告文案「自动签到只在 App 运行时执行…」；开关下方常驻一行琥珀色提示；重新打开自启后提示消失 |
| 5 | 托盘菜单保持展开、同时后台签到恰好完成 | 菜单**不应**因为重建而闪掉（只在「真有账号刚被签上」时才重建；全 `already` 的稳态轮次不动菜单） |

> 第 5 条是这次改动里唯一有争议的取舍：托盘标签要刷新就必须调 `set_menu`，而菜单展开时 `set_menu` 会让它关闭。折中方案是「只在今日已签状态可能翻转时重建」——一天最多几次，且几乎不会正好撞上用户开着菜单。若实测发现仍会闪，退路是把标签改成 tooltip 文案（tooltip 可随时更新，无闪烁）。

