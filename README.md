# HwMonitor

Windows 本地硬件监控网页服务。实时显示电池剩余容量、电量、整机功耗、硬盘容量、
CPU/内存/GPU/网络使用情况，并只读解析 DeepSeek Harness 的会话日志，统计 token 用量
与估算费用。另外提供网页 PowerShell 终端、网页 SSH 终端，以及服务一键启停。

**零第三方依赖**：只需要 Node.js，不需要 `npm install`。

---

## 快速开始

1. 把 `config.example.json` 复制为 `data/config.json`（`data/` 不入版本库，
   因为里面会存你的访问口令）。
2. 在 `data/config.json` 里设置一个 `password`。
   **网页终端只有在设置了口令后才可用** —— 这是刻意的：
   网页终端等同于远程命令执行，不能在公网上敞开。
3. 运行：

```bat
node hwm.js open-web
```

这会启动服务端（若未运行）并打开浏览器。

也可以生成桌面快捷方式（双击 = 启动服务端 + 打开浏览器）：

```bat
node tools\make-shortcuts.js
```

### 常用命令

```bat
node hwm.js open-web          启动服务端并打开浏览器
node hwm.js status            查看三个服务的状态
node hwm.js start             启动全部服务（HwMonitor + DSH + 内网穿透）
node hwm.js stop              停止服务（受保护的会被跳过）
node hwm.js dsh status        只看 DSH 状态
node hwm.js tui               终端控制台（仅用于启停服务）
node hwm.js serve             前台运行服务端（调试用）
```

`hwm.js help` 列出全部命令。

### 服务端不会开机自启

项目刻意不注册开机自启：需要时用快捷方式或 `node hwm.js open-web` 启动。
如需常驻，可用任务计划程序托管（见下方「部署为常驻服务」）。

---

## 功能总览

### 实时页

- 电池：剩余容量、健康度、循环次数、电压、充/放电功率
- 功耗：充电时显示**充电输入功率**，放电时显示整机功耗
- CPU / 内存 / GPU 仪表与每核心明细
- 磁盘容量、磁盘吞吐、网络吞吐
- 占用最高的进程
- 历史曲线（仅内存，不写磁盘）

### 网页版

- 实时页、DSH 使用页、服务页、**终端页**、硬件页、设置页
- **终端页包含两个终端**：
  - 本机 PowerShell 终端（可执行任意命令）
  - **远程 SSH 终端**（支持私钥 / 密码 / agent，可保存常用主机）
- 历史曲线（内存中保留，不写磁盘）
- 访问口令、告警阈值、模型单价等设置

---

4. **不自动打开浏览器**（按需求）。

### 关于编码的两个硬约束

这两个坑都实际踩过，改文件时请务必遵守：

- **`启动监控.bat` / `停止监控.bat` 必须是纯 ASCII。**
  cmd.exe 按控制台代码页解析批处理文件，文件里任何非 ASCII 字节（哪怕在引号内的
  PowerShell 命令里）都会让批处理本身错乱，出现 `'ist' is not recognized` 这类怪错。
  所有中文提示都由 `lib/launcher-msg.js` 用 Node 打印（Node 无条件按 UTF-8 读源码）。

- **`ps/collector.ps1` 保持纯 ASCII。**
  Windows PowerShell 5.1 在没有 UTF-8 BOM 时按系统 ANSI（中文系统是 GBK）解码 `.ps1`，
  非 ASCII 字面量会在解析期损坏，甚至让路径字面量变成乱码。
  因此采样器只输出 ASCII，中文显示文案集中在 `lib/labels.js`（JS 层）。

---

## 网页终端

「终端」页有两个终端，都等同于远程命令执行，因此**只有设置了访问口令才能使用**。

### 本机 PowerShell 终端

常驻一个 `powershell.exe` 子进程，命令写入其 stdin。
因为 PowerShell 在 stdin 模式下不打印可机读的提示符，每条命令后会回显一个
带随机令牌的哨兵行，用它标记该命令的输出结束。变量与当前目录在命令之间保留。

### 远程 SSH 终端

支持三种认证方式，按推荐顺序：

| 方式 | 说明 |
|---|---|
| **私钥**（推荐） | 使用 `~/.ssh` 下的密钥，无需在网页里输入密码 |
| **密码** | 密码仅用于本次连接，**不会保存到磁盘**；通过 askpass 助手传给 ssh，不经过命令行（避免被其他进程从 WMI 读到） |
| agent | 留空私钥和密码时由 ssh-agent 提供 |

可以「保存为主机」，只保存主机/端口/用户名/私钥路径，**不保存密码**。

**已知限制（实测结论）**：本机 OpenSSH 8.1 在 stdin 被管道接管时，
`-tt`（强制伪终端）的输出是错乱的——命令会全部挤在一行且丢失执行结果。
因此不使用伪终端，**每条命令运行在独立的远程 shell 中**，
shell 变量与工作目录不会在命令之间保留。界面会明确提示这一点，
而不是让你自己发现变量丢了。需要持续状态时，可以在一条命令里启动交互式程序
（例如 `bash` 或 `python`）。

远程输出可能是 GBK（Windows 远端控制台）而非 UTF-8，代码会检测并正确解码，
否则中文会显示成乱码。

---


## 功能

### 实时页

| 面板 | 数据来源 |
|---|---|
| 电池 | WMI `BatteryStatus`（剩余容量 mWh、电压、充放电功率）+ `powercfg` 电池报告（设计容量、满充容量、循环次数） |
| 电池健康度 | 满充容量 ÷ 设计容量 |
| **整机功耗** | 电池充/放电速率，**真实读数**而非估算（见下） |
| 预计续航 | 剩余容量 ÷ 当前放电功率 |
| CPU | 性能计数器：总占用、用户态、内核态、当前频率、每核心占用 |
| 内存 | 可用、已用、已提交、缓存 |
| GPU | `GPU Engine` 计数器，取最繁忙引擎 |
| 磁盘容量 | 每个卷的已用/剩余与占比 |
| 磁盘吞吐 | 读写速率、忙闲百分比、队列长度 |
| 网络吞吐 | 所有适配器的收发合计 |
| 进程 | 按 CPU 占用排序的进程列表 |
| 历史曲线 | 内存中保留最近 N 分钟，**不写磁盘** |

### 功耗的四种状态

采样器输出一个明确的 `power` 块，避免"这个数字到底是什么"的歧义：

| mode | 含义 | 显示 |
|---|---|---|
| `charging` | **充电输入功率** | 正数，标注"充电输入功率"，来源 `ChargeRate` |
| `discharging` | 放电功率（整机功耗） | 正数，标注"放电功率"，来源 `DischargeRate` |
| `ac-idle` | 已接电源但无充放电电流 | 0.00 W，并说明通常表示已充满或涓流维护 |
| `unknown` / `none` | 电池未报告速率 / 无电池 | 显示"—"，不猜数字 |

历史曲线上**放电为正、充电为负**，并以虚线画出零基线，两种方向都能看清。

### DSH 使用页

- 累计 token（输入 / 输出 / 推理 / 缓存读取）
- 按模型统计调用次数与 token
- 估算费用（单价可编辑，默认 0）
- 当前会话：标题、工作区、轮次、步数、待办列表
- DSH 进程占用：主进程 / 子代理 / 沙箱 的 CPU 与内存
- 工具调用次数排行
- 会话列表与每日用量

数据来自只读解析 `~/.dsh/sessions/<工作区>/<会话 id>/session.v4.jsonl.zstd`。
**HwMonitor 不会修改 DSH 的任何文件或配置**，也不作为插件加载进 DSH 进程。

### 硬件页

CPU 型号与核心数、内存条型号/频率/插槽、物理磁盘（型号、类型、序列号、健康状态）、
显卡、网络适配器、BIOS、操作系统版本。

### 设置页

采样间隔、历史窗口、访问口令、告警阈值、模型单价。全部保存到 `data/config.json`。

---

## 安全

- 默认监听 `0.0.0.0`，**局域网内任何人可访问**。
- 请在「设置 → 访问口令」中设置口令。设置后所有页面与 API 都需要登录，
  会话通过 `HttpOnly` Cookie 保持 30 天。
- 口令使用 SHA-256 哈希后做常量时间比较。
- 静态文件服务做了路径穿越防护。
- 如需只允许本机访问，把 `data/config.json` 的 `host` 改为 `"127.0.0.1"`。

---

## 配置

`data/config.json`（首次运行自动生成）：

```json
{
  "port": 8080,
  "host": "0.0.0.0",
  "password": "",
  "refreshMs": 2000,
  "historyMinutes": 15,
  "thresholds": {
    "batteryLowPct": 20,
    "diskLowFreePct": 10,
    "cpuHighPct": 90,
    "memoryHighPct": 90
  },
  "pricing": {
    "currency": "CNY",
    "models": {
      "workbuddy/deepseek-v4.1-flash": { "input": 0, "output": 0, "cacheRead": 0, "reasoning": 0 }
    },
    "defaultRates": { "input": 0, "output": 0, "cacheRead": 0, "reasoning": 0 }
  }
}
```

### 关于费用单价

单价单位是**每百万 token**，默认全部为 **0**。

这是刻意的：HwMonitor 不会猜测模型官方价格。单价为 0 时界面显示费用 0 并标注「未定价」，
不会给出一个看似真实但错误的数字。在「设置 → 模型单价」中填入真实单价后费用立即生效。

### 关于采样开销

这台机器（Celeron N3060 / 4GB）的采样开销经过实测优化，
`ps/collector.ps1` 内有注释说明每一步的原因：

- 采样器是**常驻进程**。创建性能计数器对象约需 1.6 秒，常驻后每次采样只需几毫秒。
- 进程 CPU 用 `Process.GetProcesses()` 而非 `Get-Process`（180ms → 8ms）。
- 进程命令行用**一次批量 WMI 查询 + PID 缓存**，而非每个进程查一次
  （逐进程查询曾把采样开销推到 2.5 秒）。
- `Get-PhysicalDisk`（6.8 秒）与 `powercfg`（1.1 秒）结果缓存到 `data/`。
- GPU 计数器数量多（本机 70+ 个），采样频率低于其他指标。

采样间隔默认 2000ms。界面「系统」卡片会显示**监控自身开销**（毫秒/次），
这个数字是刻意暴露的，以便你能看出监控本身占用了多少资源。

---

## 环境要求与限制

- **Windows 10/11**，PowerShell 5.1（系统自带）
- **Node.js 18+**（本机测试用 v24）
- 需要在有性能计数器的系统上运行（所有 Windows 都有）

已知限制（这台机器上实测）：

| 项目 | 情况 |
|---|---|
| 温度 | 本机未提供 ACPI 热区，界面显示「不支持」而**不会显示猜测值** |
| 显卡显存 | WMI 的 `AdapterRAM` 是 32 位字段，超过 4GB 会封顶，仅供参考 |
| 功耗 | 只有电池充/放电速率是真实读数；没有电流传感器时无法测 CPU 单独功耗 |
| 历史数据 | 只存在内存中，重启即丢失（避免在 5400 转硬盘上频繁写盘） |

---

## 目录结构

```
HwMonitor/
├── 启动监控.bat           启动（纯 ASCII，勿加中文）
├── 停止监控.bat           停止（纯 ASCII，勿加中文）
├── server.js              HTTP 服务、SSE、鉴权、路由
├── README.md
├── lib/
│   ├── collector.js       管理常驻采样子进程、历史缓冲
│   ├── config.js          配置读写（原子写入）
│   ├── dsh.js             DSH 会话日志解析与 token 聚合
│   ├── labels.js          中文显示文案（Web 与原生 GUI 共用）
│   ├── launcher-msg.js    启动脚本的中文提示输出
│   └── zstd-jsonl.js      多帧 zstd JSONL 增量解码器
├── ps/
│   ├── collector.ps1      常驻硬件采样器（输出 JSONL，纯 ASCII）
│   └── inventory.ps1      一次性硬件详单采集（纯 ASCII）
├── public/
│   ├── index.html         界面
│   ├── styles.css         样式
│   └── app.js             前端逻辑（无框架、无构建）
├── tests/                 回归测试（见下）
├── tools/
│   └── make-shortcuts.js  生成桌面快捷方式
└── data/                  运行时生成
    ├── config.json
    ├── server.pid         供启动脚本识别并清理残留进程
    ├── inventory.json     硬件详单缓存
    ├── battery-static.json 电池容量缓存
    └── disks-cache.json   物理磁盘缓存
```

---

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 存活探针（无需鉴权） |
| GET | `/api/state` | 一次性返回界面所需的全部数据 |
| GET | `/api/series` | 历史曲线数据 |
| GET | `/api/dsh` | DSH 使用报告 |
| GET | `/api/labels` | 中文显示文案（与 `/labels.js` 同源） |
| GET | `/api/hardware` | 硬件详单（缓存） |
| GET | `/api/config` | 当前配置（口令已脱敏） |
| POST | `/api/config` | 修改配置 |
| POST | `/api/dsh/rescan` | 强制全量重扫 DSH 日志 |
| POST | `/api/hardware/refresh` | 重新采集硬件详单 |
| POST | `/api/login` / `/api/logout` | 登录 / 退出 |
| GET | `/api/stream` | SSE 实时推送（`hello` / `sample` / `dsh` 事件） |

---

## 测试

```bat
cd tests
node e2e.test.js        REM 57 项：接口、鉴权、路径穿越、数据完整性、SSE
node browser.test.js    REM 浏览器脚本语法、labels 模块、脚本加载顺序
node labels.test.js     REM 功耗四种状态的文案与格式化
node zstd.test.js       REM 多帧 zstd 增量解码（含截断尾部恢复）
node dsh.test.js        REM DSH 日志解析与 token 聚合
```

`e2e.test.js` 需要服务器已在运行。

---

## 故障排查

**端口被占用**：修改 `data/config.json` 的 `port`，或运行 `停止监控.bat`。

**显示「不支持」而不是数字**：说明这台机器确实没有该传感器。
HwMonitor 的原则是不编造数据，宁可显示「不支持」。

**监控自身开销偏高**：把采样间隔调大（设置页），例如 3000–5000ms。

**看日志**（注意要指定 UTF-8，否则中文显示为乱码）：

```powershell
Get-Content data\server.log -Encoding UTF8 -Tail 30
```

**DSH 页面没有数据**：确认 `~/.dsh/sessions` 存在且有会话日志。
设置页底部会显示实际使用的路径。

**局域网访问不了**：检查 Windows 防火墙是否放行了 Node.js，
以及 `data/config.json` 中 `host` 是否为 `0.0.0.0`。
