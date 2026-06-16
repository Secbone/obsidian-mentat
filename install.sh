#!/bin/bash

# Personal Agent 插件快速安装脚本
# 用法: ./install.sh /path/to/your/vault

set -e

# 检查参数
if [ -z "$1" ]; then
    echo "❌ 错误: 请提供 Obsidian vault 路径"
    echo "用法: ./install.sh /path/to/your/vault"
    exit 1
fi

VAULT_PATH="$1"
PLUGIN_DIR="$VAULT_PATH/.obsidian/plugins/personal-agent"

# 检查 vault 是否存在
if [ ! -d "$VAULT_PATH" ]; then
    echo "❌ 错误: Vault 路径不存在: $VAULT_PATH"
    exit 1
fi

# 检查必需文件
if [ ! -f "dist/main.js" ] || [ ! -f "dist/styles.css" ] || [ ! -f "dist/manifest.json" ]; then
    echo "❌ 错误: 缺少编译文件，请先运行 npm run build"
    exit 1
fi

echo "📦 开始安装 Personal Agent 插件..."
echo ""

# 创建插件目录
echo "1️⃣  创建插件目录..."
mkdir -p "$PLUGIN_DIR"

# 复制文件
echo "2️⃣  复制插件文件..."
cp dist/main.js "$PLUGIN_DIR/"
cp dist/styles.css "$PLUGIN_DIR/"
cp dist/manifest.json "$PLUGIN_DIR/"

# 验证安装
echo "3️⃣  验证安装..."
if [ -f "$PLUGIN_DIR/main.js" ] && [ -f "$PLUGIN_DIR/styles.css" ] && [ -f "$PLUGIN_DIR/manifest.json" ]; then
    echo ""
    echo "✅ 安装成功！"
    echo ""
    echo "📍 插件位置: $PLUGIN_DIR"
    echo ""
    echo "📋 已安装文件:"
    ls -lh "$PLUGIN_DIR"
    echo ""
    echo "🔄 下一步:"
    echo "   1. 重启 Obsidian"
    echo "   2. 打开设置 → 社区插件"
    echo "   3. 启用 'Personal Agent'"
    echo "   4. 配置 AI Provider（设置 → Personal Agent）"
    echo "   5. 参考 TEST-GUIDE.md 进行测试"
    echo ""
else
    echo "❌ 安装失败，请检查文件权限"
    exit 1
fi
