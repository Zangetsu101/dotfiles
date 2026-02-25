return {
  'stevearc/conform.nvim',
  cmd = { 'ConformInfo', 'Format', 'FormatWith' },
  init = function()
    -- If you want the formatexpr, here is the place to set it
    vim.o.formatexpr = "v:lua.require'conform'.formatexpr()"
  end,
  config = function()
    local conform = require 'conform'

    local formatters_by_ft = {
      lua = { 'stylua' },
      javascript = { 'prettierd' },
      typescript = { 'prettierd' },
      typescriptreact = { 'prettierd' },
      rust = { 'rustfmt' },
      sh = { 'shfmt' },
      sql = { 'pg_format' },
    }

    conform.setup {
      formatters_by_ft = formatters_by_ft,
      -- Set default options
      default_format_opts = {
        lsp_format = 'fallback',
      },
      -- Customize formatters
      formatters = {
        shfmt = {
          append_args = { '-i', '2' },
        },
        pg_format = {
          append_args = { '--spaces', '2', '--no-space-function' },
        },
      },
    }

    vim.api.nvim_create_user_command('Format', function(args)
      local range = nil
      if args.count ~= -1 then
        local end_line = vim.api.nvim_buf_get_lines(0, args.line2 - 1, args.line2, true)[1]
        range = {
          start = { args.line1, 0 },
          ['end'] = { args.line2, end_line:len() },
        }
      end
      conform.format { async = true, lsp_format = 'fallback', range = range }
    end, { range = true })

    vim.api.nvim_create_user_command('FormatWith', function(args)
      local buf_ft = vim.bo.filetype
      local ft_formatters = formatters_by_ft[buf_ft]
      if not ft_formatters or #ft_formatters == 0 then
        vim.notify('No formatters available for ' .. buf_ft, vim.log.levels.WARN)
        return
      end

      local formatter_names = {}
      for _, f in ipairs(ft_formatters) do
        if type(f) == 'string' then
          table.insert(formatter_names, f)
        end
      end

      local range = nil
      if args.count ~= -1 then
        local end_line = vim.api.nvim_buf_get_lines(0, args.line2 - 1, args.line2, true)[1]
        range = {
          start = { args.line1, 0 },
          ['end'] = { args.line2, end_line:len() },
        }
      end

      vim.ui.select(formatter_names, {
        prompt = 'Select Formatter:',
      }, function(choice)
        if choice then
          conform.format { async = true, formatters = { choice }, range = range }
        end
      end)
    end, {})
  end,
}
