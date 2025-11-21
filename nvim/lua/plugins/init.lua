return {
  'tpope/vim-fugitive',
  'tpope/vim-rhubarb',
  'b0o/schemastore.nvim',
  'windwp/nvim-ts-autotag',
  'tpope/vim-repeat',
  {
    'nvim-mini/mini.nvim',
    version = '*',
    config = function()
      require('mini.ai').setup { n_lines = 500 }
      require('mini.surround').setup()
      require('mini.pairs').setup()
      require('mini.move').setup()
      require('mini.comment').setup {
        options = {
          custom_commentstring = function()
            return require('ts_context_commentstring').calculate_commentstring() or vim.bo.commentstring
          end,
        },
      }
    end
  },
  { -- Additional text objects via treesitter
    'nvim-treesitter/nvim-treesitter-textobjects',
    dependencies = 'nvim-treesitter',
  },
  {
    "iamcco/markdown-preview.nvim",
    cmd = { "MarkdownPreviewToggle", "MarkdownPreview", "MarkdownPreviewStop" },
    build = "cd app && yarn install",
    init = function()
      vim.g.mkdp_filetypes = { "markdown" }
    end,
    ft = { "markdown" },
  },
  {
    'mrcjkb/haskell-tools.nvim',
    version = '^4', -- Recommended
    lazy = false,   -- This plugin is already lazy
  },
  'mfussenegger/nvim-dap',
  {
    'mrcjkb/rustaceanvim',
    version = '^6',   -- Recommended
    lazy = false,     -- This plugin is already lazy
  },
  'NMAC427/guess-indent.nvim', -- Detect tabstop and shiftwidth automatically
  'tpope/vim-unimpaired',
  'JoosepAlviste/nvim-ts-context-commentstring',
  {
    'andymass/vim-matchup',
    init = function()
      vim.g.matchup_matchparen_offscreen = { method = "popup" }
    end
  }
}
