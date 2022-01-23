local lualine = require('lualine')

lualine.setup {
  options = {
    theme = 'gruvbox'
  },
  sections = {
    lualine_x = {'filetype'}
  },
  extensions = {'nvim-tree', 'fugitive', 'quickfix'}
}
