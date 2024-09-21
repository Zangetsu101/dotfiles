return require('packer').startup(function(use)
	use 'wbthomason/packer.nvim'

	use {
		'nvim-telescope/telescope.nvim', tag = '0.1.3',
		requires = { { 'nvim-lua/plenary.nvim' } }
	}

	use { 'nvim-telescope/telescope-fzf-native.nvim', run = 'make', cond = vim.fn.executable 'make' == 1 }

	use {
		'nvim-tree/nvim-tree.lua',
		requires = {
			'nvim-tree/nvim-web-devicons',
		},
		tag = 'nightly'
	}
	use { -- LSP Configuration & Plugins
		'neovim/nvim-lspconfig',
		requires = {
			-- Automatically install LSPs to stdpath for neovim
			'williamboman/mason.nvim',
			'williamboman/mason-lspconfig.nvim',

			-- Useful status updates for LSP
			{ 'j-hui/fidget.nvim', tag = 'legacy' },

			-- Additional lua configuration, makes nvim stuff amazing
			'folke/neodev.nvim',
		},
	}

	use { -- Autocompletion
		'hrsh7th/nvim-cmp',
		requires = { 'hrsh7th/cmp-nvim-lsp', 'L3MON4D3/LuaSnip', 'saadparwaiz1/cmp_luasnip' },
	}

	use { -- Highlight, edit, and navigate code
		'nvim-treesitter/nvim-treesitter',
		run = function()
			local ts_update = require('nvim-treesitter.install').update({ with_sync = true })
			ts_update()
		end,
	}

	use { -- Additional text objects via treesitter
		'nvim-treesitter/nvim-treesitter-textobjects',
		after = 'nvim-treesitter',
	}
	use {
		'andymass/vim-matchup',
		setup = function()
			-- may set any options here
			vim.g.matchup_matchparen_offscreen = { method = "popup" }
		end
	}
	use 'windwp/nvim-ts-autotag'
	use 'tpope/vim-fugitive'
	use 'tpope/vim-rhubarb'
	use 'JoosepAlviste/nvim-ts-context-commentstring'
	use 'navarasu/onedark.nvim'
	use 'tpope/vim-unimpaired'
	use 'lewis6991/gitsigns.nvim'
	use 'nvim-lualine/lualine.nvim'          -- Fancier statusline
	use 'lukas-reineke/indent-blankline.nvim' -- Add indentation guides even on blank lines
	use 'numToStr/Comment.nvim'              -- "gc" to comment visual regions/lines
	use 'tpope/vim-sleuth'                   -- Detect tabstop and shiftwidth automatically
	use 'b0o/schemastore.nvim'
	use 'tpope/vim-repeat'
	use 'tpope/vim-surround'
	use 'tpope/vim-endwise'
	use 'matze/vim-move'
	use 'rstacruz/vim-closer'
	use 'nvim-telescope/telescope-ui-select.nvim'
	use 'simrat39/rust-tools.nvim'
	use 'aserowy/tmux.nvim'
	use 'nvim-treesitter/nvim-treesitter-context'
	use {
		'mrcjkb/haskell-tools.nvim',
		tag = '3.0.2',
		ft = { 'haskell', 'lhaskell', 'cabal', 'cabalproject' }
	}
	use {
		"pmizio/typescript-tools.nvim",
		requires = { "nvim-lua/plenary.nvim", "neovim/nvim-lspconfig" },
		config = function()
			require("typescript-tools").setup {}
		end,
	}
	use({
		"iamcco/markdown-preview.nvim",
		run = "cd app && npm install",
		setup = function() vim.g.mkdp_filetypes = { "markdown" } end,
		ft = { "markdown" },
	})
end)
