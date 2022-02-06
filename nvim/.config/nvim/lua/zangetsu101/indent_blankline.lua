local indent_blankline = require('indent_blankline')

vim.opt.list = true
vim.opt.listchars:append("eol:↴")
vim.g.indent_blankline_use_treesitter = true
vim.g.indent_blankline_filetype_exclude = { 'help' }

indent_blankline.setup {
  show_end_of_line = true,
  show_current_context = true,
  show_current_context_start = true
}
