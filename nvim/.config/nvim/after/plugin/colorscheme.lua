vim.o.termguicolors = true

require('onedark').setup {
  transparent = true,
  lualine = {
    transparent = true
  },
  diagnostics = {
    background = false
  }
}

vim.cmd.colorscheme('onedark')
