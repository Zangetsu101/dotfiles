return {
  'aserowy/tmux.nvim',
  keys = function()
    local tmux = require('tmux')
    return {
      { '<C-w>h', tmux.move_left },
      { '<C-w>j', tmux.move_bottom },
      { '<C-w>k', tmux.move_top },
      { '<C-w>l', tmux.move_right },
    }
  end,
  opts = {
    copy_sync = {
      sync_unnamed = false
    },
    navigation = {
      enable_default_keybindings = false,
    },
    resize = {
      enable_default_keybindings = false,
    },
  }
}
