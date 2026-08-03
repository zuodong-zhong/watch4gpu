# GPU Watch

GPU Watch 是一个本地优先的 GPU 集群监控面板。它通过你已有的 SSH 配置读取 NVIDIA GPU、训练进程和资源占用信息；数据保留在运行面板的电脑上，不依赖云端服务。

> 重要：本仓库不包含任何真实服务器地址、SSH 账号、姓名映射、密码或私钥。首次运行后，请按下文配置自己的环境。

## 功能

- 展示节点在线状态，以及每块 GPU 的利用率、显存、温度和功耗
- 展示计算进程的账号、PID、运行时长和显存占用
- 支持直连 SSH 节点，以及通过网关和远端登录脚本进入计算节点
- 自动识别常见 Python、torchrun、DeepSpeed、Accelerate 和 Swift 训练进程
- 支持 10 / 30 / 60 秒自动刷新、手动刷新和暂停
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

仓库中的 `login.sh` 是通用模板。它默认调用网关用户目录中的 `~/connect.exp`：

```bash
bash ~/login.sh 24
```

也可在网关上通过环境变量指定脚本：

```bash
export WATCH4GPU_EXPECT_SCRIPT=/secure/path/connect.exp
```

`connect.exp` 往往包含认证逻辑，绝对不要提交到 Git、发送到群聊或放入公开目录。优先使用 SSH key、受限账号和最小权限；如果不需要中转模式，可以忽略 `login.sh`。

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
| `WATCH4GPU_USER_PATH_PREFIXES` | 空 | 用于推断进程归属的共享目录前缀，逗号分隔，例如 `/shared/users,/data/team` |
| `WATCH4GPU_EXPECT_SCRIPT` | `~/connect.exp` | 网关上的 expect 脚本路径，由 `login.sh` 使用 |

本地 API 默认只监听 `127.0.0.1`，不要把它直接暴露到公网。开发环境自动允许来自 `localhost`、`127.0.0.1` 和 `::1` 的页面；只有确有需要时才配置额外来源。

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
