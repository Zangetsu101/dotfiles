local telescope = require('telescope')

telescope.setup {
  defaults = {
    path_display = {'truncate'}
  }
}

telescope.load_extension('fzf')
