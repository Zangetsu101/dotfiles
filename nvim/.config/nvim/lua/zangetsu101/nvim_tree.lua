local nvim_tree = require('nvim-tree')

nvim_tree.setup {
  filters = {
    dotfiles = true
  },
  hijack_cursor = true,
  view = {
    mappings = {
      list = {
        { key = "I",         action = "" },
        { key = "H",         action = "" },
        { key = "<Leader>i", action = "toggle_git_ignored" },
        { key = "<Leader>h", action = "toggle_dotfiles" }
      }
    }
  }
}
