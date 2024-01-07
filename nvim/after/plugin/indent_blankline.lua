vim.opt.list = true

require('ibl').setup {
  indent = { char = '┊' },
  whitespace = {
    highlight = { "Whitespace", "NonText" }
  },
  scope = {
    highlight = { "Function", "Label" }
  }
}
