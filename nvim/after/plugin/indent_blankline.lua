vim.opt.list = true
vim.opt.listchars:append("eol:↴")

require('ibl').setup {
  indent = { char = '┊' },
  whitespace = {
    highlight = { "Whitespace", "NonText" }
  },
  scope = {
    highlight = { "Function", "Label" }
  }
}
