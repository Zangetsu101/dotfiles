local flat_configs = {
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
}

local function eslint_options(filename, root)
  local flat_config = vim.fs.find(flat_configs, {
    path = vim.fs.dirname(filename),
    upward = true,
    type = 'file',
    stop = vim.fs.dirname(root),
  })[1]

  return {
    cwd = flat_config and vim.fs.dirname(flat_config) or root,
    wrap_linter = function(linter)
      if not flat_config then
        linter.env = vim.tbl_extend('keep', vim.fn.environ(), { ESLINT_USE_FLAT_CONFIG = 'false' })
      end

      if vim.uv.fs_stat(root .. '/.pnp.cjs') or vim.uv.fs_stat(root .. '/.pnp.js') then
        linter.cmd = 'yarn'
        linter.args = vim.list_extend({ 'exec', 'eslint' }, linter.args)
        return linter
      end

      for dir in vim.fs.parents(filename) do
        local executable = vim.fs.joinpath(dir, 'node_modules', '.bin', 'eslint')
        if vim.fn.executable(executable) == 1 then
          linter.cmd = executable
          break
        end
        if dir == root then
          break
        end
      end
      return linter
    end,
  }
end

return {
  'mfussenegger/nvim-lint',
  event = 'BufWritePost',
  config = function()
    local lint = require 'lint'
    local eslint = vim.lsp.config.eslint
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
        elseif vim.tbl_contains(eslint.filetypes, filetype) then
          eslint.root_dir(event.buf, function(root)
            lint.try_lint('eslint', eslint_options(filename, root))
          end)
        end
      end,
    })
  end,
}
