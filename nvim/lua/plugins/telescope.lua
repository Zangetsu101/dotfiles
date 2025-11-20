return {
  'nvim-telescope/telescope.nvim',
  event = 'VimEnter',
  tag = 'v0.1.9',
  dependencies = {
    'nvim-lua/plenary.nvim',
    { -- If encountering errors, see telescope-fzf-native README for installation instructions
      'nvim-telescope/telescope-fzf-native.nvim',

      -- `build` is used to run some command when the plugin is installed/updated.
      -- This is only run then, not every time Neovim starts up.
      build = 'make',

      -- `cond` is a condition used to determine whether this plugin should be
      -- installed and loaded.
      cond = function()
        return vim.fn.executable 'make' == 1
      end,
    },
    { 'nvim-telescope/telescope-ui-select.nvim' },
    -- Useful for getting pretty icons, but requires a Nerd Font.
    { 'nvim-tree/nvim-web-devicons' },
  },
  config = function()
    local telescope = require('telescope')
    local actions = require('telescope.actions')

    telescope.setup {
      defaults = {
        file_ignore_patterns = {
          "^.git/"
        }
      },
      pickers = {
        find_files = {
          hidden = true
        },
        grep_string = {
          additional_args = { "--hidden" }
        },
        live_grep = {
          additional_args = { "--hidden" }
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

    pcall(telescope.load_extension, 'fzf')
    pcall(telescope.load_extension, 'ui-select')

    local builtin = require('telescope.builtin')

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
    vim.keymap.set('n', '<leader>/', builtin.current_buffer_fuzzy_find,
      { desc = '[/] Fuzzily search in current buffer]' })
    vim.keymap.set('n', '<leader>sf', function() builtin.find_files({ hidden = true }) end,
      { desc = '[S]earch [F]iles' })
    vim.keymap.set('n', '<leader>sh', builtin.help_tags, { desc = '[S]earch [H]elp' })
    vim.keymap.set('n', '<leader>sw', builtin.grep_string, { desc = '[S]earch current [W]ord' })
    vim.keymap.set('v', '<leader>sw', search_vtext, { desc = '[S]earch selection' })
    vim.keymap.set('n', '<leader>sg', function() builtin.live_grep({ hidden = true }) end,
      { desc = '[S]earch by [G]rep' })
    vim.keymap.set('n', '<leader>sd', builtin.diagnostics, { desc = '[S]earch [D]iagnostics' })
    vim.keymap.set('n', '<leader>sr', builtin.resume, { desc = '[S]earch [R]esume' })

    vim.api.nvim_create_user_command('Rg', function(opts)
        builtin.grep_string({ search = opts.fargs[1] })
      end,
      { nargs = 1 }
    )
  end
}
