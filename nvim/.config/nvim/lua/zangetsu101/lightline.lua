vim.g.lightline = {
  active = {
    left = {
      { 'mode', 'past' },
      { 'gitbranch', 'readonly', 'filename', 'modified' }
    },
    right = {
      { 'filetype', 'fileencoding', 'lineinfo', 'percent' }
    }
  },
  component_function = {
    gitbranch = 'fugitive#head'
  }
}
