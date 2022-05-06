local telescope = require('telescope')
local layout_actions = require('telescope.actions.layout')

telescope.setup {
  defaults = {
    path_display = {'truncate'},
    preview = {
      hide_on_startup = true
    },
    mappings = {
      n = {
        ["<C-h>"] = layout_actions.toggle_preview
      },
      i = {
        ["<C-h>"] = layout_actions.toggle_preview
      }
    }
  }
}

telescope.load_extension('fzf')
