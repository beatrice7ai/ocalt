#!/usr/bin/env bash
# OCALT Scheduler setup — creates agent workspaces and installs deps
set -euo pipefail

cd "$(dirname "$0")"

echo "📦 Installing dependencies..."
bun install

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "📝 Created config.json from example. Edit it with your schedules."
else
  echo "✅ config.json already exists."
fi

mkdir -p logs

echo ""
echo "✅ Setup complete!"
echo ""
echo "Next steps:"
echo "  1. Edit config.json with your agents and schedules"
echo "  2. Add your Telegram bot token and user ID (optional)"
echo "  3. Run: bun run start"
echo "  4. Watch: tmux attach -t ocalt"
echo ""
