local cmp = require('cmp')
local lspkind = require('lspkind')
local luasnip = require('luasnip')

cmp.setup {
  completion = {
    autocomplete = false
  },
  mapping = {
    ['<C-b>'] = cmp.mapping(cmp.mapping.scroll_docs(-4), { 'i', 'c' }),
    ['<C-f>'] = cmp.mapping(cmp.mapping.scroll_docs(4), { 'i', 'c' }),
    ['<C-Space>'] = cmp.mapping(cmp.mapping.complete(), { 'i', 'c' })
  },
	-- Format the autocomplete menu
	formatting = {
		format = lspkind.cmp_format()
	},
  snippet = {
    expand = function(args)
      luasnip.lsp_expand(args.body)
    end
  },
  sources = {
    { name = 'nvim_lsp' },
    { name = 'luasnip' },
  }
}
