if command -v keychain >/dev/null; then
    eval "$(keychain -q --eval)"
fi

if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null \
    && command -v powershell.exe >/dev/null \
    && [ -x "$HOME/.dotfiles/bash/wsl-ssh-askpass" ]; then
    export SSH_ASKPASS="$HOME/.dotfiles/bash/wsl-ssh-askpass"
elif [ -x /usr/bin/ssh-askpass ]; then
    export SSH_ASKPASS=/usr/bin/ssh-askpass
fi

if [ -n "${SSH_ASKPASS:-}" ]; then
    export SSH_ASKPASS_REQUIRE=prefer
fi
