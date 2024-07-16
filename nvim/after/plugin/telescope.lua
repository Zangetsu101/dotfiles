local telescope = require('telescope')

pcall(telescope.load_extension, 'fzf')
pcall(telescope.load_extension, 'ui-select')

local builtin = require('telescope.builtin')
local actions = require('telescope.actions')

telescope.setup {
  pickers = {
    find_files = {
      hidden = true
    },
    grep_string = {
      additional_args = {"--hidden"}
    },
    live_grep = {
      additional_args = {"--hidden"}
    },
    buffers = {
      mappings = {
        n = {
          x = actions.delete_buffer
        }
      }
    }
  }
}

local function buf_vtext()
  local a_orig = vim.fn.getreg('a')
  local mode = vim.fn.mode()
  if mode ~= 'v' and mode ~= 'V' then
    vim.cmd([[normal! gv]])
  end
  vim.cmd([[silent! normal! "aygv]])
  local text = vim.fn.getreg('a')
  vim.fn.setreg('a', a_orig)
  return text
end

local function search_vtext()
  local vtext = buf_vtext()
  builtin.grep_string({ search = vtext })
end

vim.keymap.set('n', '<leader>?', builtin.oldfiles, { desc = '[?] Find recently opened files' })
vim.keymap.set('n', '<leader><space>', builtin.buffers, { desc = '[ ] Find existing buffers' })
vim.keymap.set('n', '<leader>/', builtin.current_buffer_fuzzy_find, { desc = '[/] Fuzzily search in current buffer]' })
vim.keymap.set('n', '<leader>sf', function() builtin.find_files({ hidden = true }) end, { desc = '[S]earch [F]iles' })
vim.keymap.set('n', '<leader>sh', builtin.help_tags, { desc = '[S]earch [H]elp' })
vim.keymap.set('n', '<leader>sw', builtin.grep_string, { desc = '[S]earch current [W]ord' })
vim.keymap.set('v', '<leader>sw', search_vtext, { desc = '[S]earch selection' })
vim.keymap.set('n', '<leader>sg', function() builtin.live_grep({ hidden = true }) end, { desc = '[S]earch by [G]rep' })
vim.keymap.set('n', '<leader>sd', builtin.diagnostics, { desc = '[S]earch [D]iagnostics' })
vim.keymap.set('n', '<leader>sr', builtin.resume, { desc = '[S]earch [R]esume' })

vim.api.nvim_create_user_command('Rg', function(opts)
  builtin.grep_string({ search = opts.fargs[1] })
end,
  { nargs = 1 }
)
