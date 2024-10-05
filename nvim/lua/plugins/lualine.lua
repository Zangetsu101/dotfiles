return {
  'nvim-lualine/lualine.nvim',
  opts = {
    options = {
      icons_enabled = false,
      component_separators = '|',
      section_separators = ''
    },
    extensions = { 'nvim-tree', 'fugitive' }
  }
}
