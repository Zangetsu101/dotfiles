return {
  'tpope/vim-fugitive',
  'tpope/vim-rhubarb',
  'b0o/schemastore.nvim',
  'windwp/nvim-ts-autotag',
  'tpope/vim-repeat',
  'tpope/vim-surround',
  'tpope/vim-endwise',
  'matze/vim-move',
  'rstacruz/vim-closer',
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
    "pmizio/typescript-tools.nvim",
    dependencies = { "nvim-lua/plenary.nvim", "neovim/nvim-lspconfig" },
    opts = {},
  },
  {
    'mrcjkb/haskell-tools.nvim',
    version = '^4', -- Recommended
    lazy = false, -- This plugin is already lazy
  },
  'mfussenegger/nvim-dap',
  {
    'mrcjkb/rustaceanvim',
    version = '^5', -- Recommended
    lazy = false, -- This plugin is already lazy
  },
  'tpope/vim-sleuth', -- Detect tabstop and shiftwidth automatically,
  'tpope/vim-unimpaired',
  'JoosepAlviste/nvim-ts-context-commentstring',
  { 'andymass/vim-matchup', init = function()
    vim.g.matchup_matchparen_offscreen = { method = "popup" }
  end }
}
