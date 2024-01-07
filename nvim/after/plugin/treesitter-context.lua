require('treesitter-context').setup {
  max_lines = 2, -- How many lines the window should span. Values <= 0 mean no limit.
  multiline_threshold = 1, -- Maximum number of lines to show for a single context
}

vim.g.skip_ts_context_commentstring_module = true

require('ts_context_commentstring').setup {
  enable_autocmd = false
}
