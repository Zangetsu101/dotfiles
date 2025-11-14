local bufnr = vim.api.nvim_get_current_buf()

local map = function(keys, func, desc, mode)
  mode = mode or 'n'
  vim.keymap.set(mode, keys, func, { buffer = bufnr, desc = 'LSP: ' .. desc })
end

map('gra', function() vim.cmd.RustLsp('codeaction') end, '[G]oto Code [A]ction', { 'n', 'x' })

map('K', function() vim.cmd.RustLsp({'hover', 'actions'}) end, 'Hover Documentation')
