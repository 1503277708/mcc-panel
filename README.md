# 🎮 MCC 控制面板

一个为 [Minecraft Console Client](https://github.com/MCCTeam/Minecraft-Console-Client) 做的 Web 控制面板。
**不用懂服务器，浏览器打开就能操作 MCC。**

## ✨ 功能

- 🖱️ **网页按钮一键发指令**（16 个常用指令，无需记 MCC 命令）
- 💬 **实时日志**（聊天、命令、系统消息分类显示）
- 👥 **在线玩家列表**（含 ping）
- 🔌 **服务器信息面板**（地址/端口/版本/在线人数）
- ⚙️ **连接 / 账号 / 机器人 三标签配置**
- 🤖 **机器人开关**：自动重连、关键词回复、防 AFK、聊天记录
- 🔐 **Token 鉴权**（首次访问要求输入）
- 💾 **配置自动保存**（localStorage + 后端持久化）
- 🔄 **崩溃自动重启**（systemd + 后端双重保险）
- 📱 **移动端适配**（手机也能用）

## 📦 部署步骤

### 1. 买一台 VPS（推荐）

| 预算 | 推荐 | 月费 | 备注 |
|------|------|------|------|
| 💰 极低 | RackNerd 1G | ~$1/月 | 年付便宜，需自己换源 |
| ⚖️ 均衡 | 萤光云 / LightNode | 30-50 元 | 国内延迟低 |
| 💎 稳 | 腾讯云 / 阿里云 2C2G | 80-100 元 | 备案/ToS 风险 |

> 推荐配置：**1 核 2G 内存 / 20G SSD / 1Mbps+** 即可，Debian 12 / Ubuntu 22.04 系统。

### 2. 一键安装

SSH 连上服务器，依次执行：

```bash
# 上传代码包到服务器（或 git clone）
scp -r mcc-panel root@你的服务器IP:/opt/

# SSH 上去
ssh root@你的服务器IP

# 跑安装脚本
cd /opt/mcc-panel
bash install.sh
```

### 3. 打开面板

浏览器访问：
```
http://你的服务器IP:8080
```

首次访问会要求输入 token，token 在服务器的：
```bash
cat /opt/mcc-panel/config/token.txt
```

### 4. 填配置

在面板右侧「**连接**」标签填入：
- 服务器地址
- 端口
- （可选）版本

「**账号**」标签填入：
- 登录方式（mojang / microsoft / offline）
- 邮箱或玩家名
- 密码

点 **连接**，就开始跟服务器握手了。

## 🛠️ 常用运维命令

```bash
# 查看状态
systemctl status mcc-panel

# 查看实时日志
journalctl -u mcc-panel -f

# 重启
systemctl restart mcc-panel

# 停掉
systemctl stop mcc-panel

# 查看 token
cat /opt/mcc-panel/config/token.txt

# 看 MCC 输出日志
tail -f /opt/mcc-panel/logs/mcc-2026-07-24.log
```

## 🔒 安全建议

1. **首次登录后改 token**
   ```bash
   rm /opt/mcc-panel/config/token.txt
   systemctl restart mcc-panel
   cat /opt/mcc-panel/config/token.txt  # 看新 token
   ```

2. **开 HTTPS**（强烈推荐）
   ```bash
   apt install -y nginx certbot python3-certbot-nginx
   # 把面板反代到 443 + Let's Encrypt 证书
   ```

3. **别用 root 运行**（生产环境）
   ```bash
   useradd -m mccuser
   chown -R mccuser:mccuser /opt/mcc-panel
   # 改 systemd 的 User=mccuser
   ```

4. **密码别明文存**：用 MCC 自带的 session token 机制，登录一次就存 token，下次自动登。

## 📁 文件结构

```
mcc-panel/
├── public/
│   └── index.html          # 前端面板（你看到的样子）
├── config/
│   └── token.txt           # 鉴权 token（自动生成）
├── logs/
│   └── mcc-YYYY-MM-DD.log  # MCC 输出日志（按天）
├── Minecraft-Console-Client/   # MCC 程序（install.sh 自动下载）
│   ├── MinecraftClient     # MCC 主程序
│   └── MinecraftClient.ini # MCC 配置（首次启动生成）
├── server.js               # Node.js 后端
├── package.json
└── install.sh              # 一键安装脚本
```

## 🤝 自定义快捷指令

打开 `public/index.html`，找到这一段：

```html
<button class="action-btn" data-cmd="home">
  <span class="label">回家</span>
  <span class="hint">/home</span>
</button>
```

`data-cmd` 的值就是点击时发给 MCC 的命令。改它、删它、复制它就行。

比如想加一个"自雷"按钮：
```html
<button class="action-btn danger" data-cmd="kill">
  <span class="label">自雷</span>
  <span class="hint">/kill</span>
</button>
```

## 🐛 故障排查

| 问题 | 原因 | 解决 |
|------|------|------|
| 打开 8080 是空白 | 防火墙没开 | `ufw allow 8080` 或在云控制台安全组放行 |
| `MCC binary not found` | MCC 没下载 | 看 install.sh 第 7 步，或手动下 |
| 点了"连接"没反应 | 端口被占用 | `lsof -i :8080` 杀掉 |
| 一直转圈"启动中" | 缺 .NET 8 | 看 install.sh 第 3 步 |
| 玩家列表空白 | 权限不足 | MCC `/list` 是 OP 命令，给 MCC 账号 OP |

## 📜 License

MIT，随便用。
