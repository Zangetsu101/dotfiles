require('nvim-lsp-installer').setup {
  automatic_installation = true
}
local lspconfig = require('lspconfig')
local servers = { 'clangd', 'dockerls', 'eslint', 'graphql', 'jsonls', 'ltex', 'sumneko_lua', 'tsserver', 'vimls', 'yamlls' }

local capabilities = vim.lsp.protocol.make_client_capabilities()
capabilities = require('cmp_nvim_lsp').update_capabilities(capabilities)

local on_attach = function(client, bufnr)
  local function buf_set_keymap(...) vim.api.nvim_buf_set_keymap(bufnr, ...) end
  local opts = { noremap=true, silent=true }

  buf_set_keymap('n', 'gD', '<cmd>lua vim.lsp.buf.declaration()<CR>', opts)
  buf_set_keymap('n', 'gd', '<cmd>lua vim.lsp.buf.definition()<CR>', opts)
  buf_set_keymap('n', 'K', '<cmd>lua vim.lsp.buf.hover()<CR>', opts)
  buf_set_keymap('n', 'gi', '<cmd>lua vim.lsp.buf.implementation()<CR>', opts)
  buf_set_keymap('i', '<C-k>', '<cmd>lua vim.lsp.buf.signature_help()<CR>', opts)
  buf_set_keymap('n', '<space>D', '<cmd>lua vim.lsp.buf.type_definition()<CR>', opts)
  buf_set_keymap('n', '<space>rn', '<cmd>lua vim.lsp.buf.rename()<CR>', opts)
  buf_set_keymap('n', '<space>ca', '<cmd>lua vim.lsp.buf.code_action()<CR>', opts)
  buf_set_keymap('n', 'gr', '<cmd>lua vim.lsp.buf.references()<CR>', opts)
  buf_set_keymap('n', '<space>e', '<cmd>lua vim.diagnostic.open_float()<CR>', opts)
  buf_set_keymap('n', '[d', '<cmd>lua vim.diagnostic.goto_prev()<CR>', opts)
  buf_set_keymap('n', ']d', '<cmd>lua vim.diagnostic.goto_next()<CR>', opts)
  buf_set_keymap('n', '<space>q', '<cmd>lua vim.diagnostic.setloclist()<CR>', opts)

  if client.supports_method('textDocument/formatting') then
    vim.cmd [[command!-buffer Format lua vim.lsp.buf.formatting()]]
  end
end

local enhance_server_opts = {
  ['eslint'] = function(opts)
    opts.on_attach = function(client, bufnr)
      client.resolved_capabilities.document_formatting = true
      on_attach(client, bufnr)
    end
  end,
  ['jsonls'] = function(opts)
    opts.settings = {
      json = {
        schemas = require('schemastore').json.schemas {
          select = {
            '.eslintrc',
            'lerna.json',
            'package.json',
            'prettierrc.json',
            'tsconfig.json',
            'tslint.json'
          },
          replace = {
            ['tsconfig.json'] = {
              description = 'JSON schema for typescript configuration files',
              fileMatch = {'tsconfig*.json'},
              name = 'tsconfig.json',
              url = 'https://json.schemastore.org/tsconfig.json'
            }
          }
        }
      }
    }
  end,
  ['ltex'] = function(opts)
    opts.filetypes = { 'gitcommit' }
    opts.single_file_support = true
  end,
  ['sumneko_lua'] = function(opts)
    local luadev = require('lua-dev').setup {
      lspconfig = opts
    }
    opts = luadev
  end,
  ['tsserver'] = function(opts)
    opts.on_attach = function(client, bufnr)
      client.resolved_capabilities.document_formatting = false
      on_attach(client, bufnr)
    end
  end,
  ['yamlls'] = function(opts)
    opts.settings = {
      json = {
        schemas = require('schemastore').json.schemas {
          select = {
            'docker-compose.yml'
          }
        }
      }
    }
  end
}

for _, name in pairs(servers) do
  local opts = {
    capabilities = capabilities,
    on_attach = on_attach
  }

  if enhance_server_opts[name] then
    enhance_server_opts[name](opts)
  end
  lspconfig[name].setup(opts)
end
