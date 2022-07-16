local lualine = require('lualine')

lualine.setup {
  sections = {
    lualine_x = {'filetype'}
  },
  extensions = {'nvim-tree', 'fugitive', 'quickfix'}
}
