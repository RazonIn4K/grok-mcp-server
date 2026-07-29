#!/bin/bash

# Quick status check for Grok MCP Server
echo "📊 Grok MCP Server Status Check"
echo "==============================="
echo ""

cd "$(cd "$(dirname "$0")" && pwd)" 2>/dev/null || cd .

# 1. Directory and files
echo "📁 Files and Directories:"
echo "   ✅ package.json: $([ -f package.json ] && echo "EXISTS" || echo "MISSING")"
echo "   ✅ dist/index.js: $([ -f dist/index.js ] && echo "EXISTS" || echo "MISSING")"
echo "   ✅ .envrc: $([ -f .envrc ] && echo "EXISTS" || echo "MISSING")"
echo "   ✅ run-with-env.sh: $([ -f run-with-env.sh ] && echo "EXISTS" || echo "MISSING")"

# 2. Permissions
echo ""
echo "🔐 File Permissions:"
echo "   run-with-env.sh: $([ -x run-with-env.sh ] && echo "EXECUTABLE" || echo "NOT EXECUTABLE")"
echo "   setup-grok.sh: $([ -x setup-grok.sh ] && echo "EXECUTABLE" || echo "NOT EXECUTABLE")"
echo "   update-mcp-config-direnv.sh: $([ -x update-mcp-config-direnv.sh ] && echo "EXECUTABLE" || echo "NOT EXECUTABLE")"

# 3. Dependencies
echo ""
echo "📦 Dependencies:"
echo "   node_modules: $([ -d node_modules ] && echo "EXISTS" || echo "MISSING")"

# 4. Environment
echo ""
echo "🌍 Environment:"
source ~/.zshrc 2>/dev/null
if [ -n "$XAI_API_KEY" ] || [ -n "$X_AI_API_KEY" ]; then
    ACTIVE_KEY="${XAI_API_KEY:-$X_AI_API_KEY}"
    echo "   XAI_API_KEY: FOUND (${ACTIVE_KEY:0:10}...)"
else
    echo "   XAI_API_KEY: NOT FOUND"
fi

if [ -n "$SHARED_SECRET" ]; then
    echo "   SHARED_SECRET: FOUND"
else
    echo "   SHARED_SECRET: NOT FOUND"
fi

# 5. Node.js
echo ""
echo "📋 Node.js:"
if command -v node &> /dev/null; then
    echo "   Version: $(node --version)"
else
    echo "   Node.js: NOT INSTALLED"
fi

# 6. direnv
echo ""
echo "🔧 direnv:"
if command -v direnv &> /dev/null; then
    echo "   direnv: INSTALLED"
    if [ -f .envrc ]; then
        direnv status . 2>/dev/null | grep -q "allowed" && echo "   .envrc: ALLOWED" || echo "   .envrc: NOT ALLOWED"
    fi
else
    echo "   direnv: NOT INSTALLED"
fi

echo ""
echo "🎯 Quick Fix Commands:"
echo "   Make executable: chmod +x *.sh"
echo "   Install deps: npm install"
echo "   Build project: npm run build"
echo "   Allow direnv: direnv allow ."
echo "   Run diagnosis: ./diagnose-and-fix.sh"
