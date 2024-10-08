return {
  'nvim-treesitter/nvim-treesitter',
  build = ':TSUpdate',
  main = 'nvim-treesitter.configs', -- Sets main module to use for opts
  opts = {
    ensure_installed = { 'c', 'cpp', 'css', 'dockerfile', 'graphql', 'jsonc', 'lua', 'rust', 'tsx', 'typescript',
      'vimdoc', 'markdown', 'markdown_inline', 'bash', 'diff', 'html', 'luadoc', 'query', 'vim' },
    autotag = {
      enable = true
    },
    highlight = {
      enable = true
    },
    indent = {
      enable = true
    },
    matchup = {
      enable = true
    },
    incremental_selection = {
      enable = true,
      keymaps = {
        init_selection = '<c-space>',
        node_incremental = '<c-space>',
        scope_incremental = '<c-s>',
        node_decremental = '<c-backspace>'
      }
    },
    textobjects = {
      select = {
        enable = true,
        lookahead = true, -- Automatically jump forward to textobj, similar to targets.vim
        keymaps = {
          -- You can use the capture groups defined in textobjects.scm
          ['aa'] = '@parameter.outer',
          ['ia'] = '@parameter.inner',
          ['af'] = '@function.outer',
          ['if'] = '@function.inner',
          ['ac'] = '@class.outer',
          ['ic'] = '@class.inner'
        }
      },
      move = {
        enable = true,
        set_jumps = true, -- whether to set jumps in the jumplist
        goto_next_start = {
          [']m'] = '@function.outer',
          [']]'] = '@class.outer'
        },
        goto_next_end = {
          [']M'] = '@function.outer',
          [']['] = '@class.outer'
        },
        goto_previous_start = {
          ['[m'] = '@function.outer',
          ['[['] = '@class.outer'
        },
        goto_previous_end = {
          ['[M'] = '@function.outer',
          ['[]'] = '@class.outer'
        },
      },
      swap = {
        enable = true,
        swap_next = {
          ['<leader>a'] = '@parameter.inner'
        },
        swap_previous = {
          ['<leader>A'] = '@parameter.inner'
        }
      }
    }
  }
}
