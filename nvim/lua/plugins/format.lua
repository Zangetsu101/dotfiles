return {
  "stevearc/conform.nvim",
  cmd = { "ConformInfo", "Format" },
  init = function()
    -- If you want the formatexpr, here is the place to set it
    vim.o.formatexpr = "v:lua.require'conform'.formatexpr()"
  end,
  config = function()
    local conform = require('conform')

    conform.setup {
      -- Define your formatters
      formatters_by_ft = {
        lua = { "stylua" },
        javascript = { "eslint_d", "prettierd", stop_after_first = true },
        typescript = { "eslint_d", "prettierd", stop_after_first = true },
        typescriptreact = { "eslint_d", "prettierd", stop_after_first = true },
        rust = { "rustfmt" },
        sh = { "shfmt" },
        sql = { "pgformatter" },
      },
      -- Set default options
      default_format_opts = {
        lsp_format = "fallback",
      },
      -- Customize formatters
      formatters = {
        shfmt = {
          append_args = { "-i", "2" },
        },
      },
    }

    vim.api.nvim_create_user_command("Format", function(args)
      local range = nil
      if args.count ~= -1 then
        local end_line = vim.api.nvim_buf_get_lines(0, args.line2 - 1, args.line2, true)[1]
        range = {
          start = { args.line1, 0 },
          ["end"] = { args.line2, end_line:len() },
        }
      end
      conform.format({ async = true, lsp_format = "fallback", range = range })
    end, { range = true })
  end
}
