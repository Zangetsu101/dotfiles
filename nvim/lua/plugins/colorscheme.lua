vim.o.termguicolors = true

return {
  'navarasu/onedark.nvim',
  config = true,
  init = function()
    vim.cmd.colorscheme('onedark')
  end,
  opts = {
    transparent = true,
    lualine = {
      transparent = true
    },
    diagnostics = {
      background = false
    }
  }
}
