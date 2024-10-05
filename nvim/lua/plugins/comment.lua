local ts_context_commentstring = require('ts_context_commentstring.integrations.comment_nvim')

return {
  'numToStr/Comment.nvim',
  opts = {
    pre_hook = ts_context_commentstring.create_pre_hook(),
  }
}
