#!/bin/bash

# Grok 4 MCP Server Setup Script
# This script will install dependencies, build the server, and help configure Claude Code integration

echo "🚀 Setting up Grok 4 MCP Server for Claude Code Integration"
echo "============================================================"
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ]; then
    echo "❌ Error: Please run this script from the grok-4-mcp-server directory"
    echo "   cd /Users/davidortiz/MCP-Servers/grok-4-mcp-server"
    exit 1
fi

# Check Node.js version
echo "📋 Checking Node.js version..."
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 18+ first."
    echo "   Visit: https://nodejs.org/"
    exit 1
fi

NODE_VERSION=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "❌ Node.js version 18+ is required. Current version: $(node --version)"
    exit 1
fi

echo "✅ Node.js version: $(node --version)"

# Install dependencies
echo ""
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

# Build the project
echo ""
echo "🔨 Building TypeScript project..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build failed"
    exit 1
fi

echo "✅ Build successful"

# Check if .env file exists
echo ""
echo "🔧 Checking environment configuration..."
if [ ! -f ".env" ]; then
    echo "⚠️  No .env file found. Creating from template..."
    cp .env.example .env
    echo "📝 Please edit .env file and add your xAI API key:"
    echo "   XAI_API_KEY=xai-your-actual-api-key-here"
    echo ""
    echo "🔑 To get your API key:"
    echo "   1. Visit https://console.x.ai"
    echo "   2. Create account or sign in"
    echo "   3. Generate API key"
    echo "   4. Copy key to .env file"
    echo ""
    read -p "Press Enter after you've added your API key to .env..."
else
    echo "✅ .env file exists"
fi

# Test API connection (if API key is provided)
echo ""
echo "🧪 Testing API connection..."
if grep -q "xai-.*" .env 2>/dev/null; then
    echo "Testing Grok API connection..."
    npm start &
    SERVER_PID=$!
    sleep 3
    kill $SERVER_PID 2>/dev/null
    echo "✅ Server startup test completed"
else
    echo "⚠️  API key not found in .env file. Skipping connection test."
    echo "   Please add your xAI API key to test the connection."
fi

# Claude Code MCP configuration
echo ""
echo "🎯 Claude Code MCP Configuration"
echo "================================"
echo ""
echo "To integrate with Claude Code, add this to your MCP configuration:"
echo ""

# Detect OS and provide appropriate config path
if [[ "$OSTYPE" == "darwin"* ]]; then
    MCP_CONFIG_PATH="~/.config/claude-code/mcp.json"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    MCP_CONFIG_PATH="~/.config/claude-code/mcp.json"
else
    MCP_CONFIG_PATH="~/.config/claude-code/mcp.json"
fi

echo "Configuration file: $MCP_CONFIG_PATH"
echo ""
echo "Add this JSON configuration:"
echo ""
cat << 'EOF'
{
  "mcpServers": {
    "grok-4": {
      "command": "node",
      "args": ["/Users/davidortiz/MCP-Servers/grok-4-mcp-server/dist/index.js"],
      "env": {
        "XAI_API_KEY": "xai-your-actual-api-key-here"
      }
    }
  }
}
EOF

echo ""
echo "⚠️  Important: Replace 'xai-your-actual-api-key-here' with your real API key!"
echo ""

# Create a helper script for easy MCP config update
echo "📝 Creating MCP configuration helper..."
cat << 'EOF' > update-mcp-config.sh
#!/bin/bash

# Get API key from .env file
API_KEY=$(grep XAI_API_KEY .env | cut -d'=' -f2)

if [ -z "$API_KEY" ]; then
    echo "❌ No API key found in .env file"
    exit 1
fi

MCP_CONFIG_DIR="$HOME/.config/claude-code"
MCP_CONFIG_FILE="$MCP_CONFIG_DIR/mcp.json"

# Create config directory if it doesn't exist
mkdir -p "$MCP_CONFIG_DIR"

# Create or update MCP configuration
cat > "$MCP_CONFIG_FILE" << EOL
{
  "mcpServers": {
    "grok-4": {
      "command": "node",
      "args": ["$(pwd)/dist/index.js"],
      "env": {
        "XAI_API_KEY": "$API_KEY"
      }
    }
  }
}
EOL

echo "✅ Updated Claude Code MCP configuration: $MCP_CONFIG_FILE"
echo "🔄 Please restart Claude Code to load the new configuration"
EOF

chmod +x update-mcp-config.sh

echo "✅ Created update-mcp-config.sh helper script"
echo ""
echo "🎊 Setup Complete!"
echo "=================="
echo ""
echo "Next steps:"
echo "1. Add your xAI API key to .env file (if not done already)"
echo "2. Run: ./update-mcp-config.sh (to auto-configure Claude Code)"
echo "3. Restart Claude Code"
echo "4. Test with: grok_test_connection tool"
echo ""
echo "🎯 Perfect for your database security and bug bounty workflows!"
echo "   Use grok_ask for learning, grok_search for research, grok_chat for discussions"
echo ""
echo "📚 Read README.md for detailed usage examples and integration tips"