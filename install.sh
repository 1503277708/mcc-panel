#!/bin/bash
# ============================================================
# MCC Control Panel - 一键安装脚本
# 用法:  curl -sSL install-url | bash
# 或本地:  bash install.sh
# ============================================================
set -e

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  🎮 MCC 控制面板 · 一键安装"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# Detect OS
if [ -f /etc/os-release ]; then
  . /etc/os-release
  OS=$ID
else
  OS=$(uname -s | tr '[:upper:]' '[:lower:]')
fi

echo "📍 系统: $OS"

# 1. Install Node.js if missing
if ! command -v node &> /dev/null; then
  echo "📦 安装 Node.js..."
  if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif [[ "$OS" == "centos" || "$OS" == "rhel" || "$OS" == "rocky" || "$OS" == "almalinux" ]]; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  else
    echo "❌ 不支持的系统: $OS"
    exit 1
  fi
fi
echo "✅ Node $(node -v)"

# 2. Install build tools (for node-pty)
echo "📦 安装编译工具..."
if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
  apt-get install -y build-essential python3
elif [[ "$OS" == "centos" || "$OS" == "rhel" || "$OS" == "rocky" || "$OS" == "almalinux" ]]; then
  yum groupinstall -y "Development Tools"
  yum install -y python3
fi

# 3. Install .NET runtime (for MCC)
if ! command -v dotnet &> /dev/null; then
  echo "📦 安装 .NET 8 runtime (MCC 需要)..."
  if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
    wget -q https://dot.net/v1/dotnet-install.sh -O /tmp/dotnet-install.sh
    chmod +x /tmp/dotnet-install.sh
    /tmp/dotnet-install.sh --channel 8.0 --runtime dotnet
    echo 'export PATH=$PATH:$HOME/.dotnet' >> ~/.bashrc
    export PATH=$PATH:$HOME/.dotnet
  else
    echo "⚠️  请手动安装 .NET 8: https://dotnet.microsoft.com/download"
  fi
fi

# 4. Create app dir
APP_DIR="/opt/mcc-panel"
echo "📂 安装到 $APP_DIR"
mkdir -p $APP_DIR
cd $APP_DIR

# 5. Copy files (assumes this script runs from the package dir)
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
cp -r $SCRIPT_DIR/* $APP_DIR/ 2>/dev/null || {
  echo "⚠️  本地文件未找到，将通过 git 拉取"
  git clone https://github.com/your-repo/mcc-panel.git . || {
    echo "❌ 无法获取文件，请手动上传到 $APP_DIR"
    exit 1
  }
}

# 6. Install npm deps
echo "📦 安装依赖..."
npm install --production

# 7. Download MCC if missing
if [ ! -f "$APP_DIR/Minecraft-Console-Client/MinecraftClient" ]; then
  echo "📥 下载 Minecraft Console Client..."
  cd $APP_DIR
  wget -q https://github.com/MCCTeam/Minecraft-Console-Client/releases/latest/download/Minecraft-Console-Client-Linux-x64.zip
  unzip -q Minecraft-Console-Client-Linux-x64.zip
  rm Minecraft-Console-Client-Linux-x64.zip
  chmod +x Minecraft-Console-Client/MinecraftClient
fi

# 8. Create systemd service
echo "⚙️  创建 systemd 服务..."
cat > /etc/systemd/system/mcc-panel.service << EOF
[Unit]
Description=MCC Control Panel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/server.js
Restart=always
RestartSec=10
Environment=NODE_ENV=production
Environment=PATH=/root/.dotnet:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable mcc-panel
systemctl start mcc-panel

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  ✅ 安装完成!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  🌐 访问面板:  http://你的服务器IP:8080"
echo "  🔑 Token:     cat $APP_DIR/config/token.txt"
echo ""
echo "  📊 查看状态:  systemctl status mcc-panel"
echo "  📜 查看日志:  journalctl -u mcc-panel -f"
echo "  🔄 重启服务:  systemctl restart mcc-panel"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
