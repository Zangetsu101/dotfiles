return {
  'mfussenegger/nvim-lint',
  event = 'BufWritePost',
  config = function()
    local lint = require 'lint'
    lint.linters.shellcheck.args = { '--format', 'json1', '--external-sources' }
    lint.linters.shellcheck.stdin = false

    vim.list_extend(lint.linters.ktlint.args, {
      '--stdin-path',
      function()
        return vim.api.nvim_buf_get_name(0)
      end,
    })

    vim.api.nvim_create_autocmd('BufWritePost', {
      group = vim.api.nvim_create_augroup('nvim-lint', { clear = true }),
      callback = function(event)
        local filetype = vim.bo[event.buf].filetype
        local filename = vim.api.nvim_buf_get_name(event.buf)
        if filetype == 'kotlin' then
          lint.try_lint 'ktlint'
        elseif filetype == 'sh' or filetype == 'bash' then
          lint.try_lint('shellcheck', { cwd = vim.fs.root(event.buf, '.git') or vim.fs.dirname(filename) })
        elseif filetype == 'yaml' then
          local root = filename:match '^(.*)/%.github/workflows/[^/]+%.ya?ml$'
          if root then
            lint.try_lint('actionlint', { cwd = root })
          end
        end
      end,
    })
  end,
}
