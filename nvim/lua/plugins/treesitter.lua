return {
  'nvim-treesitter/nvim-treesitter',
  lazy = false,
  branch = 'main',
  build = ':TSUpdate',
  config = function()
    local treesitter = require('nvim-treesitter')

    local parsers = { 'c', 'cpp', 'css', 'dockerfile', 'graphql', 'lua', 'rust', 'tsx', 'typescript',
      'vimdoc', 'markdown', 'markdown_inline', 'bash', 'diff', 'html', 'luadoc', 'query', 'vim' }

    treesitter.install(parsers)

    ---@param buf integer
    ---@param language string
    local function treesitter_try_attach(buf, language)
      -- Check if a parser exists and load it
      if not vim.treesitter.language.add(language) then return end
      -- Enable syntax highlighting and other treesitter features
      vim.treesitter.start(buf, language)

      -- Check if treesitter indentation is available for this language, and if so enable it
      -- in case there is no indent query, the indentexpr will fallback to the vim's built in one
      local has_indent_query = vim.treesitter.query.get(language, 'indents') ~= nil

      -- Enable treesitter based indentation
      if has_indent_query then vim.bo.indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()" end
    end

    vim.api.nvim_create_autocmd('FileType', {
      callback = function(args)
        local buf, filetype = args.buf, args.match

        local language = vim.treesitter.language.get_lang(filetype)
        if not language then return end

        local installed_parsers = treesitter.get_installed 'parsers'

        if vim.tbl_contains(installed_parsers, language) then
          -- Enable parsers installed from the explicit list above.
          treesitter_try_attach(buf, language)
        end
      end,
    })
  end,
}
