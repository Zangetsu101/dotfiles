vim.opt.list = true

return {
  'lukas-reineke/indent-blankline.nvim',
  main = 'ibl',
  opts = {
    indent = { char = '┊' },
    whitespace = {
      highlight = { "Whitespace", "NonText" }
    },
    scope = {
      highlight = { "Function", "Label" }
    }
  }
}
