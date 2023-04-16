local tmux = require('tmux')

tmux.setup {
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

vim.keymap.set('n', '<C-w>h', tmux.move_left)
vim.keymap.set('n', '<C-w>j', tmux.move_bottom)
vim.keymap.set('n', '<C-w>k', tmux.move_top)
vim.keymap.set('n', '<C-w>l', tmux.move_right)
