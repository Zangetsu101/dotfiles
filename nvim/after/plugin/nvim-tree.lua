local nvim_tree = require('nvim-tree')

nvim_tree.setup {
  filters = {
    dotfiles = true
  },
  view = {
    mappings = {
      list = {
        { key = "I", action = "" },
        { key = "H", action = "" },
        { key = "<Leader>i", action = "toggle_git_ignored" },
        { key = "<Leader>h", action = "toggle_dotfiles" }
      }
    }
  }
}

local api = require('nvim-tree.api')

vim.keymap.set('n', '<leader>t', api.tree.toggle, { desc = '[T]oggle Tree' })
vim.keymap.set('n', '<leader>f', function() api.tree.toggle(true) end, { desc = '[T]oggle Tree' })
