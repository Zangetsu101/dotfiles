path_prepend() {
    case ":$PATH:" in
        *":$1:"*) ;;
        *) PATH="$1:$PATH" ;;
    esac
}

path_append() {
    case ":$PATH:" in
        *":$1:"*) ;;
        *) PATH="$PATH:$1" ;;
    esac
}

path_prepend "$HOME/.local/bin"

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && source "$NVM_DIR/bash_completion"

[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

export PNPM_HOME="$HOME/.local/share/pnpm"
[ -d "$PNPM_HOME/bin" ] && path_prepend "$PNPM_HOME/bin"

[ -d "$HOME/.maestro/bin" ] && path_append "$HOME/.maestro/bin"

if [ -d "$HOME/Android/Sdk" ]; then
    export ANDROID_HOME="$HOME/Android/Sdk"
    path_append "$ANDROID_HOME/platform-tools"
fi

command -v kubectl >/dev/null && source <(kubectl completion bash)
command -v starship >/dev/null && eval "$(starship init bash)"

unset -f path_prepend path_append
