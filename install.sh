#!/bin/bash

# apidev installer

set -e

DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"
CONF_DIR="$HOME/.apidev"
BIN_NAME="api"
CLI_PATH="$DIR/api.js"

echo "🚀 Installing apidev..."

# 1. Setup config directory
echo "Creating $CONF_DIR..."
mkdir -p "$CONF_DIR"
if [ -f "$DIR/apis.txt" ]; then
    cp "$DIR/apis.txt" "$CONF_DIR/apis.txt"
    echo "✅ Copied apis.txt to $CONF_DIR/apis.txt"
else
    echo "⚠️  apis.txt not found in $DIR, skipping copy."
fi

# 2. Make api.js executable
chmod +x "$CLI_PATH"

# 3. Ask to add to PATH
echo ""
read -p "Do you want to add the '$BIN_NAME' command to your PATH? (y/n) " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    SHELL_CONFIG=""
    if [[ "$SHELL" == */zsh ]]; then
        SHELL_CONFIG="$HOME/.zshrc"
    elif [[ "$SHELL" == */bash ]]; then
        if [ -f "$HOME/.bash_profile" ]; then
            SHELL_CONFIG="$HOME/.bash_profile"
        else
            SHELL_CONFIG="$HOME/.bashrc"
        fi
    fi

    if [ -n "$SHELL_CONFIG" ]; then
        if ! grep -q "alias $BIN_NAME=" "$SHELL_CONFIG" && ! grep -q "$DIR" "$SHELL_CONFIG"; then
            echo "Adding alias to $SHELL_CONFIG..."
            echo "" >> "$SHELL_CONFIG"
            echo "# apidev" >> "$SHELL_CONFIG"
            echo "alias $BIN_NAME='$CLI_PATH'" >> "$SHELL_CONFIG"
            echo "✅ Added '$BIN_NAME' alias to $SHELL_CONFIG"
            echo "👉 Run 'source $SHELL_CONFIG' or restart your terminal to use it."
        else
            echo "ℹ️  '$BIN_NAME' already seems to be in $SHELL_CONFIG"
        fi
    else
        echo "❌ Could not detect shell config file. Please add this manually:"
        echo "alias $BIN_NAME='$CLI_PATH'"
    fi
fi

echo ""
echo "🎉 Installation complete!"
echo "Note: By default, the CLI will look for apis.txt in its own directory."
echo "To use your personal config, you can use the 'configPath' override in the module"
echo "or update the CLI to check $CONF_DIR/apis.txt."
