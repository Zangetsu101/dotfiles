return {
  'aserowy/tmux.nvim',
  keys = function()
    return {
      { '<C-w>h', function() require('tmux').move_left() end },
      { '<C-w>j', function() require('tmux').move_bottom() end },
      { '<C-w>k', function() require('tmux').move_top() end },
      { '<C-w>l', function() require('tmux').move_right() end },
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
