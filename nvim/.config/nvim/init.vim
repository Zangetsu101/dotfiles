" Install VimPlug:
let data_dir = has('nvim') ? stdpath('data') . '/site' : '~/.vim'
if empty(glob(data_dir . '/autoload/plug.vim'))
  silent execute '!curl -fLo '.data_dir.'/autoload/plug.vim --create-dirs https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim'
  autocmd VimEnter * PlugInstall --sync | source $MYVIMRC
endif

" Plugins:
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
Plug 'nvim-lualine/lualine.nvim'
Plug 'lewis6991/gitsigns.nvim'
Plug 'neovim/nvim-lspconfig'
Plug 'hrsh7th/nvim-cmp'
Plug 'hrsh7th/cmp-nvim-lsp'
Plug 'L3MON4D3/LuaSnip'
Plug 'saadparwaiz1/cmp_luasnip'
Plug 'onsails/lspkind-nvim'
Plug 'nvim-treesitter/nvim-treesitter'
Plug 'nvim-treesitter/nvim-treesitter-textobjects'
Plug 'lukas-reineke/indent-blankline.nvim'
Plug 'jiangmiao/auto-pairs'
Plug 'matze/vim-move'
Plug 'kyazdani42/nvim-web-devicons'
Plug 'kyazdani42/nvim-tree.lua'
Plug 'williamboman/nvim-lsp-installer'
Plug 'b0o/schemastore.nvim'
Plug 'glacambre/firenvim'
Plug 'ray-x/lsp_signature.nvim'

call plug#end()

" Leader Shortcuts:
let mapleader=' '

call plug#end()

" FireNvim:
if exists('g:started_by_firenvim')
  set guifont=monospace:h12
endif

" Colorscheme:
set termguicolors
let g:gruvbox_italic=1
colorscheme gruvbox
set background=dark
highlight link LspSignatureActiveParameter GruvboxYellow

" Source all the lua files
lua require('zangetsu101')

" Commands:

" Usage:
"   :Files [hidden=false no_ignore=false]

" Parameters:
"   hidden     (boolean)  show hidden files or not
"   no_ignore  (boolean)  show files ignored by .gitignore, .ignore, etc.

command -nargs=* Files Telescope find_files <args>

" Usage:
"   :Ag findMe
"
" Parameters:
"   findMe  (string)  string to search for

command -nargs=1 Ag lua require('telescope.builtin').grep_string {search=<f-args>}

command BLines Telescope current_buffer_fuzzy_find

nnoremap <silent> <leader><space> :Telescope buffers<CR>
nnoremap <silent> <leader>sf :Telescope find_files<CR>
nnoremap <silent> <leader>sb :Telescope current_buffer_fuzzy_find<CR>
nnoremap <silent> <leader>sg :Telescope grep_string<CR>
nnoremap <silent> <leader>sl :Telescope live_grep<CR>
nnoremap <silent> <leader>sr :Telescope resume<CR>
nnoremap <silent> <leader>t :NvimTreeToggle<CR>
nnoremap <silent> <leader>f :NvimTreeFindFile<CR>

" Genereal Settings:
set noshowmode
set signcolumn=yes

" enables syntax highlighting
syntax on

" enable current line highlight
set cursorline

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

" case insensitive search unless capital letters are used
set ignorecase
set smartcase
