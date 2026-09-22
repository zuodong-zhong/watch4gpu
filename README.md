# GPU Watch

GPU Watch 是一个本地优先的 GPU 集群监控面板。它通过你已有的 SSH 配置读取 NVIDIA GPU、训练进程和资源占用信息；数据保留在运行面板的电脑上，不依赖云端服务。

> 重要：本仓库不包含任何真实服务器地址、SSH 账号、姓名映射、密码或私钥。首次运行后，请按下文配置自己的环境。

## 功能

- 展示节点在线状态，以及每块 GPU 的利用率、显存、温度和功耗
- 展示计算进程的账号、PID、运行时长和显存占用
- 可按人名筛选，只显示该用户正在使用的 GPU 卡片
- “我的 GPU”概览按节点列出自己正在使用的卡号与型号，自动合并同名账号，并区分归属冲突和过期数据
- 点击右上角月亮／太阳按钮，在浅色与黑色主题间切换；浏览器会记住选择
- 支持直连 SSH 节点，以及通过网关和远端登录脚本进入计算节点
- 自动识别常见 Python、torchrun、DeepSpeed、Accelerate 和 Swift 训练进程
- 容器进程显示为 `root` 时，可通过只读挂载信息识别项目目录的实际用户；多用户证据不一致时不会强行猜测
- 各节点独立采集，完成后等待 10 / 30 / 60 秒再刷新；支持手动刷新和暂停
- 同一节点的进行中采集会被复用，手动刷新或多个页面不会叠加 SSH 连接；慢节点不会拖住其他节点的结果更新
- 只在 `127.0.0.1` 上提供本地 API，默认不接受外部网页来源

## 运行要求

- Node.js 22.13 或更高版本
- npm
- 本机可用的 OpenSSH 客户端
- 目标服务器已安装 NVIDIA 驱动，并可执行 `nvidia-smi`
- 推荐使用 SSH key 或 ssh-agent；采集过程使用 `BatchMode=yes`，不会弹出密码输入框
- 中转模式若使用本仓库的 `login.sh` 模板，还需要在网关安装 `expect`

## 快速开始

```bash
git clone https://github.com/<your-account>/watch4gpu.git
cd watch4gpu
npm ci
npm run watch4gpu
```

浏览器打开 [http://localhost:3000](http://localhost:3000)。按 `Ctrl+C` 可同时停止前端和本地采集服务。

同一时间只需运行一个实例。如果提示采集端口（默认 `8787`）已被占用，请检查是否已有 GPU Watch 在运行；已有实例可直接使用，需要重启时先在原终端按 `Ctrl+C` 退出。

仓库初始不带节点。打开页面后点击“添加节点”，完成配置并保存即可。

## 配置直连节点

先在 `~/.ssh/config` 中配置一个可免交互登录的 Host 别名：

```sshconfig
Host gpu-server-01
  HostName 192.0.2.10
  User researcher
  Port 22
  IdentityFile ~/.ssh/id_ed25519
```

`192.0.2.10` 是文档示例地址，请替换为你自己的服务器地址。确认以下命令无需输入密码：

```bash
ssh -o BatchMode=yes gpu-server-01 nvidia-smi
```

然后在页面中添加“直连 SSH”节点：

- 配置 ID：本地唯一标识，例如 `gpu-server-01`
- 显示名称：页面展示名称，可自由填写
- SSH Host 别名：必须与 `~/.ssh/config` 中的 `Host` 一致
- HostName / IP、用户、端口：用于页面展示；真正连接参数仍以 SSH 配置为准

## 配置中转节点

中转模式适用于“先登录网关，再运行脚本进入计算节点”的环境。你需要准备：

1. 在 `~/.ssh/config` 中配置网关别名，例如 `gpu-gateway`。
2. 在网关服务器上准备登录脚本，例如 `~/login.sh`。
3. 在页面中选择“中转节点”，填写网关别名、计算节点编号和远端脚本路径。

仓库中的 `login.sh` 是通用模板。它默认调用与 `login.sh` 同目录的 `connect.exp`：

```bash
bash ~/login.sh 24
```

也可在网关上通过环境变量指定脚本：

```bash
export WATCH4GPU_EXPECT_SCRIPT=/secure/path/connect.exp
```

`connect.exp` 往往包含认证逻辑，绝对不要提交到 Git、发送到群聊或放入公开目录。优先使用 SSH key、受限账号和最小权限；如果不需要中转模式，可以忽略 `login.sh`。

采集通道默认为“交互终端”（`relayTransport: "shell"`，也可省略该字段）。如果中转服务已连接，但交互终端因 `filedescriptor out of range in select()` 等错误无法启动，可在节点编辑框中选择“兼容命令通道”（`relayTransport: "command"`）。各节点使用独立连接，无需额外打开终端。

兼容命令通道仅支持 `login.sh` / `login_1.sh` 这类通过 `expect /path/connect.exp ...` 调用 Expect 的旧式登录脚本。它在当前网关会话中临时包装 `expect`，跳过 `pexpect` 交互终端，通过 `cmd --exec /bin/bash` 执行固定的压缩只读采集命令；不会修改远端脚本或写入远端文件。其他登录方式应继续使用默认通道。

共享存储响应较慢时，兼容通道将本次新建客户端的命令确认等待延长到 15 秒，沿用同一消息和总采集超时，不增加连接会话。

## 节点与姓名映射

### 节点配置

页面保存的节点位于 `data/nodes.local.json`，该文件已被 Git 忽略。首次运行时若文件不存在，程序会读取公开模板 `data/nodes.json`，其初始内容为空：

```json
{
  "nodes": []
}
```

也可以自行创建或编辑 `data/nodes.local.json`。直连节点示例：

```json
{
  "id": "gpu-server-01",
  "name": "GPU Server 01",
  "mode": "direct",
  "sshHost": "gpu-server-01",
  "hostName": "192.0.2.10",
  "user": "researcher",
  "port": 22,
  "enabled": true
}
```

如需把配置放在其他位置，可设置 `WATCH4GPU_CONFIG_FILE`。不要把包含真实内网 IP、账号或基础设施名称的本地配置提交到公开分支。

### 用户显示名称

姓名映射是可选功能。推荐在已被 Git 忽略的 `.env.local` 中设置：

```dotenv
NEXT_PUBLIC_WATCH4GPU_USER_NAMES={"alice":"Alice","bob":"Bob"}
```

公开默认值保存在 `data/user-names.json`，内容为空对象。配置格式为：

```json
{
  "alice": "Alice",
  "bob": "Bob"
}
```

留空时页面直接显示服务器账号。`NEXT_PUBLIC_` 变量会进入本地前端页面，因此只能用于显示名称，不能放密码或令牌；姓名映射仍属于个人信息，不应提交到公开仓库。

节点列表上方的用户按钮默认为“全部用户”。选择某个人名后，页面只显示含有该用户进程的 GPU 卡片，并隐藏没有匹配 GPU 的节点；再次选择“全部用户”即可恢复完整视图。映射到同一显示名称的多个账号会合并为一个筛选项。

“我的 GPU”可以在 `.env.local` 中通过 `NEXT_PUBLIC_WATCH4GPU_MY_ACCOUNTS=alice,alice_lab` 设置默认账号，未配置时使用本地采集服务的系统账号。点击“修改账号”可同时填写多个服务器账号（逗号、顿号或空格分隔），下方会列出将统计的全部账号，同名映射也会自动合并。选择保存在当前浏览器并优先于默认配置；可点击“填入默认账号”后保存来恢复默认值。该概览独立于节点搜索和用户筛选，总是汇总所有已启用节点。

右上角的“收起／展开”按钮可隐藏或展开节点明细；收起后保留卡数和待更新提示，浏览器会记住收起状态。

统计依据为最近采集到的 GPU 进程归属。同一张卡上有多个自己的进程只计一块；归属冲突的卡单独标为“待确认”，推断归属保留“推断”标记。刷新失败或过期的记录只作历史展示，不计入当前数量；节点未就绪或进程归属不可见时会提示统计可能不完整。

## 环境变量

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WATCH4GPU_API_PORT` | `8787` | 本地采集 API 端口 |
| `WATCH4GPU_SSH_TIMEOUT_MS` | `25000` | 直连 SSH 超时毫秒数 |
| `WATCH4GPU_RELAY_TIMEOUT_MS` | `45000` | 中转连接超时毫秒数 |
| `WATCH4GPU_ALLOWED_ORIGINS` | 空 | 额外允许的网页来源，逗号分隔 |
| `WATCH4GPU_CONFIG_FILE` | `data/nodes.local.json` | 本地节点配置文件路径 |
| `NEXT_PUBLIC_WATCH4GPU_API_URL` | `http://127.0.0.1:8787` | 前端访问的 API 地址 |
| `NEXT_PUBLIC_WATCH4GPU_USER_NAMES` | 空 | JSON 格式的账号到显示名称映射 |
| `NEXT_PUBLIC_WATCH4GPU_MY_ACCOUNTS` | 空（使用本机账号） | 我的 GPU 默认服务器账号，支持逗号分隔的多个账号 |
| `WATCH4GPU_USER_PATH_PREFIXES` | 空 | 用于推断进程归属的共享目录前缀，逗号分隔，例如 `/shared/users,/data/team` |
| `WATCH4GPU_DEEP_INSPECTION_USERS` | 空（始终包含 `root`） | 需要触发容器只读深度归属检查的额外共享账户，逗号分隔 |
| `WATCH4GPU_EXPECT_SCRIPT` | `login.sh` 同目录的 `connect.exp` | 网关上的 expect 脚本路径，由 `login.sh` 使用 |

本地 API 默认只监听 `127.0.0.1`，不要把它直接暴露到公网。开发环境自动允许来自 `localhost`、`127.0.0.1` 和 `::1` 的页面；只有确有需要时才配置额外来源。

内部共享目录前缀也可以保存在已被 Git 忽略的 `data/user-path-prefixes.local.json` 中，格式为 `{ "prefixes": ["/shared/users", "/data/team"] }`。目录须为绝对路径，可使用字母、数字、下划线、点、横线和斜线；配置同时用于只读采集过滤和进程归属解析。

共享账户名单也可以放在不会提交的 `data/deep-inspection-users.local.json` 中，格式为 `{ "users": ["shared-account"] }`。名单只决定是否启动只读深度采集，不会直接决定进程归属。

## 常用命令

```bash
npm run watch4gpu  # 同时启动页面与采集服务
npm run api        # 只启动采集服务
npm run dev        # 只启动前端
npm run build      # 生产构建检查
npm run lint       # 代码检查
npm test           # 构建并运行测试
```

## 分享前的隐私检查

公开自己的分支或 Fork 前，至少检查：

```bash
git grep -nE '([0-9]{1,3}\.){3}[0-9]{1,3}|BEGIN .*PRIVATE KEY|password|passwd|token'
git status --short
```

重点确认以下内容没有进入提交历史：

- `connect.exp`、私钥、密码、访问令牌
- 真实内网 IP、SSH Host 别名、用户名和姓名映射
- 个人主目录、共享存储路径和组织内部拓扑

如果敏感信息已经提交，仅删除当前文件并不够；还需要清理 Git 历史并轮换已泄露的凭据。

## 参与贡献

提交改动前请运行：

```bash
npm run lint
npm test
```

更多约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，安全问题见 [SECURITY.md](SECURITY.md)。

## 许可证

本项目采用 [MIT License](LICENSE)。
