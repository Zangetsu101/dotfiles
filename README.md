# .dotfiles

| Config                | Path                       |
| --------------------- | -------------------------- |
| Neovim                | `nvim/`                    |
| tmux                  | `tmux/`                    |
| Alacritty             | `alacritty/alacritty.toml` |
| Starship              | `starship/starship.toml`   |
| Git                   | `git/.gitconfig`           |
| Claude Code           | `claude/`                  |
| Pi                    | `pi/agent/`                |
| Agent-agnostic skills | `agents/`                  |

## Setup

Symlink each config to where the tool expects it:

```sh
ln -s ~/.dotfiles/tmux ~/.config/tmux
ln -s ~/.dotfiles/nvim ~/.config/nvim
ln -s ~/.dotfiles/starship/starship.toml ~/.config/starship.toml
ln -s ~/.dotfiles/git/.gitconfig ~/.gitconfig
ln -s ~/.dotfiles/claude/* ~/.claude/
ln -s ~/.dotfiles/pi/agent/settings.json ~/.pi/agent/settings.json
ln -s ~/.dotfiles/pi/agent/keybindings.json ~/.pi/agent/keybindings.json
ln -s ~/.dotfiles/pi/agent/extensions ~/.pi/agent/extensions
ln -s ~/.dotfiles/claude/* ~/.claude/
ln -s ~/.dotfiles/agents ~/.agents
ln -s ~/.dotfiles/agents/skills ~/.claude/skills
```

> `claude/skills` is itself a symlink to `agents/skills/`, so Claude Code and any other agent can share the same skills.
