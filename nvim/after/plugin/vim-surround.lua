vim.api.nvim_create_autocmd("FileType", {
  pattern = "rust",
  command = 'let g:surround_124 = "|\r|"'
})
