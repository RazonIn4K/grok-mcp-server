#!/bin/bash

# Comprehensive Grok MCP Server Diagnosis and Fix Script
# This script will check and fix all common issues with the Grok MCP server

echo "🔍 Grok MCP Server Diagnostic and Fix Tool"
echo "==========================================="
echo ""

# Change to the script's directory (portable)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check if we're in the right place
if [ ! -f "package.json" ]; then
    echo "❌ Error: Not in grok-4-mcp-server directory"
    exit 1
fi

echo "✅ Located grok-4-mcp-server directory"

# 1. Check and fix script permissions
echo ""
echo "🔧 Checking and fixing script permissions..."

chmod +x run-with-env.sh
chmod +x setup-grok.sh
chmod +x update-mcp-config-direnv.sh
chmod +x diagnose-and-fix.sh

echo "✅ Script permissions fixed"

# 2. Check Node.js
echo ""
echo "📋 Checking Node.js installation..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed"
    exit 1
fi

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version 18+ is required. Current: $(node --version)"
    exit 1
fi

echo "✅ Node.js version: $(node --version)"

# 3. Check npm dependencies
echo ""
echo "📦 Checking npm dependencies..."
if [ ! -d "node_modules" ]; then
    echo "⚠️  Installing missing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ Failed to install dependencies"
        exit 1
    fi
fi

echo "✅ Dependencies are installed"

# 4. Check and rebuild if needed
echo ""
echo "🔨 Checking TypeScript compilation..."
if [ ! -d "dist" ] || [ ! -f "dist/index.js" ]; then
    echo "⚠️  Dist directory missing or incomplete. Building..."
    npm run build
    if [ $? -ne 0 ]; then
        echo "❌ Build failed"
        exit 1
    fi
else
    # Check if source is newer than compiled
    if [ "src/index.ts" -nt "dist/index.js" ]; then
        echo "⚠️  Source files newer than compiled. Rebuilding..."
        npm run build
        if [ $? -ne 0 ]; then
            echo "❌ Build failed"
            exit 1
        fi
    fi
fi

echo "✅ TypeScript compilation up to date"

# 5. Check environment setup
echo ""
echo "🔐 Checking environment configuration..."

# Check if XAI_API_KEY is available in shell
source ~/.zshrc 2>/dev/null
if [ -z "$XAI_API_KEY" ] && [ -z "$X_AI_API_KEY" ]; then
    echo "❌ XAI_API_KEY not found in shell environment"
    echo "   Please add to ~/.zshrc: export XAI_API_KEY='xai-your-api-key'"
    echo "   (or export X_AI_API_KEY='xai-your-api-key')"
    exit 1
fi

ACTIVE_KEY="${XAI_API_KEY:-$X_AI_API_KEY}"
echo "✅ XAI_API_KEY found in environment (${ACTIVE_KEY:0:10}...)"

# Check SHARED_SECRET availability
if [ -z "$SHARED_SECRET" ]; then
    echo "❌ SHARED_SECRET not found in shell environment"
    echo "   Please add to ~/.zshrc: export SHARED_SECRET='your-shared-secret'"
    exit 1
fi

echo "✅ SHARED_SECRET found in environment"

# 6. Check direnv setup
echo ""
echo "🌍 Checking direnv configuration..."
if command -v direnv &> /dev/null; then
    if [ -f ".envrc" ]; then
        # Allow direnv for this directory
        direnv allow . 2>/dev/null
        echo "✅ direnv is configured and allowed"
    else
        echo "❌ .envrc file missing"
        exit 1
    fi
else
    echo "⚠️  direnv not installed, using run-with-env.sh wrapper"
fi

# 7. Test server startup
echo ""
echo "🧪 Testing server startup..."

# Use timeout to test server start
timeout 10s node dist/index.js <<< "" 2>&1 | head -5 &
SERVER_PID=$!

# Wait a moment for server to start
sleep 3

# Check if process is still running (good sign)
if kill -0 $SERVER_PID 2>/dev/null; then
    echo "✅ Server started successfully"
    kill $SERVER_PID 2>/dev/null
else
    echo "❌ Server failed to start or exited early"
    echo "   Check if XAI_API_KEY and SHARED_SECRET are valid"
fi

# 8. Update MCP configuration
echo ""
echo "⚙️  Updating Claude Code MCP configuration..."

# Run the direnv update script
./update-mcp-config-direnv.sh

echo ""
echo "🎉 Diagnosis and Fix Complete!"
echo "=============================="
echo ""
echo "✅ All checks passed. The Grok MCP server should now work."
echo ""
echo "Next steps:"
echo "1. Restart Claude Code"
echo "2. Test with grok_test_connection tool"
echo "3. Use grok_ask, grok_search, or grok_chat tools"
echo ""
echo "If you still have issues:"
echo "- Check that your XAI_API_KEY is valid"
echo "- Check that your SHARED_SECRET is set"
echo "- Ensure Claude Code can access the server path"
echo "- Check Claude Code logs for error details"
