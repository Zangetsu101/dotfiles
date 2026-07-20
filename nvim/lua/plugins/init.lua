return {
  'tpope/vim-fugitive',
  'tpope/vim-abolish',
  'tpope/vim-rhubarb',
  'sindrets/diffview.nvim',
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
    end,
  },
  { -- Additional text objects via treesitter
    'nvim-treesitter/nvim-treesitter-textobjects',
    branch = 'main',
    config = function()
      local select = require 'nvim-treesitter-textobjects.select'
      local swap = require 'nvim-treesitter-textobjects.swap'
      vim.keymap.set({ 'x', 'o' }, 'am', function()
        select.select_textobject('@function.outer', 'textobjects')
      end)
      vim.keymap.set({ 'x', 'o' }, 'im', function()
        select.select_textobject('@function.inner', 'textobjects')
      end)
      vim.keymap.set({ 'x', 'o' }, 'ac', function()
        select.select_textobject('@class.outer', 'textobjects')
      end)
      vim.keymap.set({ 'x', 'o' }, 'ic', function()
        select.select_textobject('@class.inner', 'textobjects')
      end)
      vim.keymap.set('n', '<leader>a', function()
        swap.swap_next '@parameter.inner'
      end)
      vim.keymap.set('n', '<leader>A', function()
        swap.swap_previous '@parameter.outer'
      end)
    end,
  },
  {
    'iamcco/markdown-preview.nvim',
    cmd = { 'MarkdownPreviewToggle', 'MarkdownPreview', 'MarkdownPreviewStop' },
    build = 'cd app && yarn install',
    init = function()
      vim.g.mkdp_filetypes = { 'markdown' }
    end,
    ft = { 'markdown' },
  },
  {
    'mrcjkb/haskell-tools.nvim',
    version = '^4', -- Recommended
    lazy = false, -- This plugin is already lazy
  },
  'mfussenegger/nvim-dap',
  {
    'mrcjkb/rustaceanvim',
    version = '^6', -- Recommended
    lazy = false, -- This plugin is already lazy
  },
  'NMAC427/guess-indent.nvim', -- Detect tabstop and shiftwidth automatically
  'tpope/vim-unimpaired',
  'JoosepAlviste/nvim-ts-context-commentstring',
  {
    'andymass/vim-matchup',
    init = function()
      vim.g.matchup_matchparen_offscreen = { method = 'popup' }
    end,
  },
}
