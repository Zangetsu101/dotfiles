return {
  'neovim/nvim-lspconfig',
  dependencies = {
    -- Automatically install LSPs to stdpath for neovim
    { 'williamboman/mason.nvim', config = true },
    'williamboman/mason-lspconfig.nvim',
    'WhoIsSethDaniel/mason-tool-installer.nvim',
    -- Useful status updates for LSP
    { 'j-hui/fidget.nvim',       opts = {} },
    'hrsh7th/cmp-nvim-lsp',
  },
  -- LSP settings.
  --  This function gets run when an LSP connects to a particular buffer.
  config = function()
    local on_attach = function(_, bufnr)
      -- NOTE: Remember that lua is a real programming language, and as such it is possible
      -- to define small helper and utility functions so you don't have to repeat yourself
      -- many times.
      --
      -- In this case, we create a function that lets us more easily define mappings specific
      -- for LSP related items. It sets the mode, buffer and description for us each time.
      local nmap = function(keys, func, desc)
        if desc then
          desc = 'LSP: ' .. desc
        end

        vim.keymap.set('n', keys, func, { buffer = bufnr, desc = desc })
      end

      local imap = function(keys, func, desc)
        if desc then
          desc = 'LSP: ' .. desc
        end

        vim.keymap.set('i', keys, func, { buffer = bufnr, desc = desc })
      end

      nmap('<leader>rn', vim.lsp.buf.rename, '[R]e[n]ame')
      nmap('<leader>ca', vim.lsp.buf.code_action, '[C]ode [A]ction')

      nmap('gd', vim.lsp.buf.definition, '[G]oto [D]efinition')
      nmap('gr', require('telescope.builtin').lsp_references, '[G]oto [R]eferences')
      nmap('gI', vim.lsp.buf.implementation, '[G]oto [I]mplementation')
      nmap('<leader>D', vim.lsp.buf.type_definition, 'Type [D]efinition')
      nmap('<leader>ds', require('telescope.builtin').lsp_document_symbols, '[D]ocument [S]ymbols')
      nmap('<leader>ws', require('telescope.builtin').lsp_dynamic_workspace_symbols, '[W]orkspace [S]ymbols')

      -- See `:help K` for why this keymap
      nmap('K', vim.lsp.buf.hover, 'Hover Documentation')
      nmap('<C-k>', vim.lsp.buf.signature_help, 'Signature Documentation')
      imap('<C-k>', vim.lsp.buf.signature_help, 'Signature Documentation')

      -- Lesser used LSP functionality
      nmap('gD', vim.lsp.buf.declaration, '[G]oto [D]eclaration')
      nmap('<leader>wa', vim.lsp.buf.add_workspace_folder, '[W]orkspace [A]dd Folder')
      nmap('<leader>wr', vim.lsp.buf.remove_workspace_folder, '[W]orkspace [R]emove Folder')
      nmap('<leader>wl', function()
        print(vim.inspect(vim.lsp.buf.list_workspace_folders()))
      end, '[W]orkspace [L]ist Folders')

      -- Create a command `:Format` local to the LSP buffer
      vim.api.nvim_buf_create_user_command(bufnr, 'Format', function(_)
        vim.lsp.buf.format {
          async = true,
          filter = function(client)
            return client.name ~= 'ts_ls'
          end
        }
      end, { desc = 'Format current buffer with LSP' })
    end

    -- Enable the following language servers
    --  Feel free to add/remove any LSPs that you want here. They will automatically be installed.
    --
    --  Add any additional override configuration in the following tables. They will be passed to
    --  the `settings` field of the server config. You must look up that documentation yourself.
    local servers = {
      clangd = {},
      dockerls = {},
      eslint = {},
      graphql = {},
      ts_ls = {},
      jsonls = {
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
                fileMatch = { 'tsconfig*.json' },
                name = 'tsconfig.json',
                url = 'https://json.schemastore.org/tsconfig.json'
              }
            }
          }
        }
      },
      taplo = {},
      ltex = {},
      vimls = {},
      rust_analyzer = {},
      tailwindcss = {},
      yamlls = {
        json = {
          schemas = require('schemastore').json.schemas {
            select = {
              'docker-compose.yml'
            }
          }
        }
      },
      lua_ls = {
        Lua = {
          workspace = { checkThirdParty = false },
          telemetry = { enable = false },
        },
      },
    }

    local enhance_server_opts = {
      ['eslint'] = function(opts)
        opts.on_attach = function(client, bufnr)
          client.server_capabilities.documentFormattingProvider = true
          on_attach(client, bufnr)
        end
      end,
      ['ltex'] = function(opts)
        opts.filetypes = { 'gitcommit', 'markdown' }
        opts.single_file_support = true
      end
    }

    -- nvim-cmp supports additional completion capabilities, so broadcast that to servers
    local capabilities = vim.lsp.protocol.make_client_capabilities()
    capabilities = require('cmp_nvim_lsp').default_capabilities(capabilities)

    -- Setup mason so it can manage external tooling
    require('mason').setup()

    -- Ensure the servers above are installed
    local mason_lspconfig = require 'mason-lspconfig'

    mason_lspconfig.setup {
      ensure_installed = vim.tbl_keys(servers),
    }

    mason_lspconfig.setup_handlers {
      function(server_name)
        local opts = {
          capabilities = capabilities,
          on_attach = on_attach,
          settings = servers[server_name],
        }
        if enhance_server_opts[server_name] then
          enhance_server_opts[server_name](opts)
        end
        require('lspconfig')[server_name].setup(opts)
      end,
      ['rust_analyzer'] = function()
      end
    }
  end
}
