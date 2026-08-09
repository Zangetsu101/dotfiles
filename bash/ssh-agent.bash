if command -v keychain >/dev/null; then
    eval "$(keychain -q --eval)"
fi

if [ -x /usr/bin/ssh-askpass ]; then
    export SSH_ASKPASS=/usr/bin/ssh-askpass
    export SSH_ASKPASS_REQUIRE=prefer
fi
