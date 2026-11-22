require('config.keymaps')
require('config.autocmds')
require('config.options')
require('config.lazy')

-- Load settings for this machine from lua/config/local/, if the folder exists.
if vim.uv.fs_stat(vim.fn.stdpath('config') .. '/lua/config/local/init.lua') then
  require('config.local')
end
