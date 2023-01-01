vim.opt.list = true
vim.opt.listchars:append("eol:↴")

require('indent_blankline').setup {
  char = '┊',
  show_trailing_blankline_indent = false,
  use_treesitter = true,
  show_end_of_line = true,
  show_current_context = true,
  show_current_context_start = true
}
