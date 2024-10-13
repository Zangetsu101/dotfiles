vim.o.showmode = false
vim.o.signcolumn = 'yes'

-- enable current line highlight
vim.o.cursorline = true

-- number of spaces in a <Tab>
vim.o.tabstop = 2
vim.o.softtabstop = 2
vim.o.expandtab = true

-- enable autoindents
vim.o.smartindent = true

-- enable break indent
vim.o.breakindent = true

-- save undo history
vim.o.undofile = true

-- decrease update time
vim.o.updatetime = 250

-- decrease mapped sequence wait time
vim.opt.timeoutlen = 300

-- number of spaces used for autoindents
vim.o.shiftwidth = 2

-- adds line numbers
vim.o.number = true
vim.o.relativenumber = true

-- columns used for the line number
vim.o.numberwidth = 4

-- highlights the matched text pattern when searching
vim.o.incsearch = true
vim.o.hlsearch = false

-- case insensitive search unless capital letters are used
vim.o.ignorecase = true
vim.o.smartcase = true

-- open splits intuitively
vim.o.splitbelow = true
vim.o.splitright = true

-- navigate buffers without losing unsaved work
vim.o.hidden = true

-- start scrolling when 8 lines from top or bottom
vim.o.scrolloff = 8

-- Save undo history
vim.o.undofile = true

-- folding
vim.o.foldmethod = 'expr'
vim.o.foldexpr = 'nvim_treesitter#foldexpr()'
vim.o.foldenable = false

