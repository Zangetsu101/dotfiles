local telescope = require('telescope')
local layout_actions = require('telescope.actions.layout')

telescope.setup {
  defaults = {
    path_display = {'truncate'},
    mappings = {
      n = {
        ["<C-h>"] = layout_actions.toggle_preview
      },
      i = {
        ["<C-h>"] = layout_actions.toggle_preview
      }
    }
  },
  pickers = {
    find_files = {
      preview = {
        hide_on_startup = true
      },
    }
  }
}

telescope.load_extension('fzf')
