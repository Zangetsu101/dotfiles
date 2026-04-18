# .dotfiles

| Config                | Path                       |
| --------------------- | -------------------------- |
| Neovim                | `nvim/`                    |
| tmux                  | `tmux/`                    |
| Alacritty             | `alacritty/alacritty.toml` |
| Starship              | `starship/starship.toml`   |
| Git                   | `git/config`               |
| Claude Code           | `claude/`                  |
| Agent-agnostic skills | `agents/`                  |

## Setup

Symlink each config to where the tool expects it:

```sh
ln -s ~/.dotfiles/tmux ~/.config/tmux
ln -s ~/.dotfiles/nvim ~/.config/nvim
ln -s ~/.dotfiles/starship/starship.toml ~/.config/starship.toml
ln -s ~/.dotfiles/git/config ~/.gitconfig
ln -s ~/.dotfiles/claude/settings.json ~/.claude/settings.json
ln -s ~/.dotfiles/agents/skills ~/.claude/skills
```

> `claude/skills` is itself a symlink to `agents/skills/`, so Claude Code and any other agent can share the same skills.
