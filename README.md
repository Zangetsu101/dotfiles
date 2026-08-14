# .dotfiles

| Config                | Path                     |
| --------------------- | ------------------------ |
| Bash                  | `bash/`                  |
| Neovim                | `nvim/`                  |
| tmux                  | `tmux/`                  |
| Alacritty             | `alacritty/`             |
| Starship              | `starship/starship.toml` |
| Git                   | `git/`                   |
| Claude Code           | `claude/`                |
| Pi                    | `pi/agent/`              |
| Agent-agnostic config | `agents/`                |

## Tools

### Core

| Tool | Used for |
| ---- | -------- |
| [Alacritty](https://alacritty.org/) | Terminal emulator |
| [tmux](https://github.com/tmux/tmux) | Terminal multiplexer |
| [TPM](https://github.com/tmux-plugins/tpm) | tmux plugin management |
| [Neovim](https://neovim.io/) | Editor |
| [Starship](https://starship.rs/) | Shell prompt |
| [keychain](https://www.funtoo.org/Funtoo:Keychain) | Reuse an SSH agent between shells |
| `ssh-askpass` | Prompt for SSH key passphrases from non-interactive commands |
| [ripgrep](https://github.com/BurntSushi/ripgrep) | Telescope text search in Neovim |
| Build tools (`make`, compiler) | Native Neovim plugins such as Telescope FZF |
| [Nerd Font](https://www.nerdfonts.com/) | Neovim and terminal icons |

On Ubuntu, the packaged core dependencies can be installed with:

```sh
sudo apt install build-essential keychain openssh-client ssh-askpass ripgrep tmux neovim alacritty
```

Install Starship and TPM using their linked installation instructions.

### Optional shell integrations

The Bash configuration detects these tools and only initializes those that are installed:

- [NVM](https://github.com/nvm-sh/nvm) and [pnpm](https://pnpm.io/)
- [Rust/Cargo](https://rustup.rs/)
- [kubectl](https://kubernetes.io/docs/tasks/tools/)
- [Android SDK](https://developer.android.com/tools)
- [Maestro](https://maestro.mobile.dev/)

## Setup

Symlink each config to where the tool expects it:

```sh
printf '%s\n' '[ -f "$HOME/.dotfiles/bash/bashrc" ] && source "$HOME/.dotfiles/bash/bashrc"' >> ~/.bashrc
ln -s ~/.dotfiles/tmux ~/.config/tmux
ln -s ~/.dotfiles/nvim ~/.config/nvim
ln -s ~/.dotfiles/alacritty ~/.config/alacritty
ln -s ~/.dotfiles/starship/starship.toml ~/.config/starship.toml
ln -s ~/.dotfiles/git ~/.config/git
ln -s ~/.dotfiles/pi/agent/* ~/.pi/agent/
ln -s ~/.dotfiles/claude/* ~/.claude/
ln -s ~/.dotfiles/agents ~/.agents
ln -s ~/.dotfiles/agents/skills ~/.claude/skills
npm --prefix ~/.dotfiles/pi/agent install
```

Put machine- or employer-specific Bash settings in `bash/bashrc.local`;
the shared Bash configuration loads this gitignored file when present.

> `claude/skills` is itself a symlink to `agents/skills/`, so Claude Code and any other agent can share the same skills.
