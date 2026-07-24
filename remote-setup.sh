#!/bin/bash
# MCC Panel 一键安装 - 拉自 GitHub
set -e
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🎮 MCC 控制面板 · 一键安装"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 1. 基础环境
echo "📦 [1/5] 装基础环境..."
apt-get update -qq
apt-get install -y -qq curl wget ca-certificates gnupg build-essential python3 unzip nano git

# 2. Node.js 20
if ! command -v node &> /dev/null; then
  echo "📦 [2/5] 装 Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs
fi
echo "✅ Node $(node -v)"

# 3. .NET 8 Runtime
if ! command -v dotnet &> /dev/null; then
  echo "📦 [3/5] 装 .NET 8 Runtime..."
  wget -q https://dot.net/v1/dotnet-install.sh -O /tmp/dotnet-install.sh
  chmod +x /tmp/dotnet-install.sh
  /tmp/dotnet-install.sh --channel 8.0 --runtime dotnet --install-dir /usr/share/dotnet > /dev/null 2>&1
  ln -sf /usr/share/dotnet/dotnet /usr/local/bin/dotnet
fi
echo "✅ .NET OK"

# 4. 拉项目
echo "📥 [4/5] 拉项目文件..."
if [ ! -d /opt/mcc-panel ]; then
  git clone https://github.com/1503277708/mcc-panel.git /opt/mcc-panel
else
  cd /opt/mcc-panel && git pull
fi

# 5. 装依赖 + MCC
echo "📦 [5/5] 装 npm 依赖..."
cd /opt/mcc-panel
npm install --production --no-audit --no-fund 2>&1 | tail -3

if [ ! -f /opt/mcc-panel/Minecraft-Console-Client/MinecraftClient ]; then
  echo "📥 下 Minecraft Console Client..."
  cd /opt
  wget -q https://github.com/MCCTeam/Minecraft-Console-Client/releases/latest/download/Minecraft-Console-Client-Linux-x64.zip -O mcc.zip
  unzip -q mcc.zip -d /opt/mcc-panel/
  if [ -d /opt/mcc-panel/Minecraft-Console-Client-Linux-x64 ]; then
    mv /opt/mcc-panel/Minecraft-Console-Client-Linux-x64 /opt/mcc-panel/Minecraft-Console-Client
  fi
  chmod +x /opt/mcc-panel/Minecraft-Console-Client/MinecraftClient
  rm mcc.zip
fi
echo "✅ MCC 就绪"

# 6. systemd 服务
cat > /etc/systemd/system/mcc-panel.service << 'EOF'
[Unit]
Description=MCC Control Panel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/mcc-panel
ExecStart=/usr/bin/node /opt/mcc-panel/server.js
Restart=always
RestartSec=10
Environment=PATH=/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mcc-panel
systemctl restart mcc-panel

sleep 2
TOKEN=$(cat /opt/mcc-panel/config/token.txt 2>/dev/null || echo "")

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ 装好了！"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  🌐 访问: http://47.110.84.114:8080"
echo "  🔑 Token: $TOKEN"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  📊 systemctl status mcc-panel"
echo "  📜 journalctl -u mcc-panel -f"
echo "  🔄 systemctl restart mcc-panel"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
