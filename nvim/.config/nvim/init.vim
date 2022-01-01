let data_dir = has('nvim') ? stdpath('data') . '/site' : '~/.vim'
if empty(glob(data_dir . '/autoload/plug.vim'))
  silent execute '!curl -fLo '.data_dir.'/autoload/plug.vim --create-dirs https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim'
  autocmd VimEnter * PlugInstall --sync | source $MYVIMRC
endif

call plug#begin('~/.config/nvim/plugged')

Plug 'tpope/vim-commentary'
Plug 'tpope/vim-fugitive'
Plug 'tpope/vim-repeat'
Plug 'tpope/vim-surround'
Plug 'tpope/vim-unimpaired'
Plug 'gruvbox-community/gruvbox'
Plug 'nvim-lua/plenary.nvim'
Plug 'nvim-telescope/telescope.nvim'
Plug 'nvim-telescope/telescope-fzf-native.nvim', {'do': 'make' }
Plug 'itchyny/lightline.vim'
Plug 'lewis6991/gitsigns.nvim'
Plug 'neovim/nvim-lspconfig'
Plug 'hrsh7th/nvim-cmp'
Plug 'hrsh7th/cmp-nvim-lsp'
Plug 'L3MON4D3/LuaSnip'
Plug 'saadparwaiz1/cmp_luasnip'
Plug 'onsails/lspkind-nvim'
Plug 'nvim-treesitter/nvim-treesitter', { 'do': ':TSUpdate' }
Plug 'nvim-treesitter/nvim-treesitter-textobjects'
Plug 'lukas-reineke/indent-blankline.nvim'
Plug 'jiangmiao/auto-pairs'
Plug 'matze/vim-move'

call plug#end()

lua require('zangetsu101')

" remap space as leader key
let mapleader=' '

" add leader shortcuts
nnoremap silent <leader><space> lua require('telescope.builtin').buffers()<CR>
nnoremap <silent> <leader>sf :Telescope find_files<CR>
nnoremap <silent> <leader>sb :Telescope current_buffer_fuzzy_find<CR>
nnoremap <silent> <leader>sp :Telescope live_grep<CR>

" set colorscheme
set termguicolors
colorscheme gruvbox
set background=dark

set noshowmode
set signcolumn=yes

" enables syntax highlighting
syntax on

" Better colors
set termguicolors

" number of spaces in a <Tab>
set tabstop=2
set softtabstop=2
set expandtab

" enable autoindents
set smartindent

" enable break indent
set breakindent

" save undo history
set undofile

" decrease update time
set updatetime=250

" number of spaces used for autoindents
set shiftwidth=2

" adds line numbers
set number
set relativenumber

" columns used for the line number
set numberwidth=4

" highlights the matched text pattern when searching
set incsearch
set nohlsearch

" open splits intuitively
set splitbelow
set splitright

" navigate buffers without losing unsaved work
set hidden

" start scrolling when 8 lines from top or bottom
set scrolloff=2

" Save undo history
set undofile

" Enable mouse support
set mouse=a

" case insensitive search unless capital letters are used
set ignorecase
set smartcase
