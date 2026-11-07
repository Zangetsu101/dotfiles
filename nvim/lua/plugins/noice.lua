return {
  'folke/noice.nvim',
  event = 'VeryLazy',
  dependencies = { 'MunifTanjim/nui.nvim' },
  opts = {
    views = {
      notify = { backend = 'snacks' },
    },
    lsp = {
      hover = { silent = true },
      -- Fidget already displays LSP progress.
      progress = { enabled = false },
      override = {
        ['vim.lsp.util.convert_input_to_markdown_lines'] = true,
        ['vim.lsp.util.stylize_markdown'] = true,
      },
    },
  },
}
