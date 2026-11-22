-- Keep pre-commit hook output visible without blocking Neovim.
local commits = {
  cc = 'Git! commit',
  ca = 'Git! commit --amend',
  ce = 'Git! commit --amend --no-edit',
  cvc = 'tab Git! commit -v',
  cva = 'tab Git! commit -v --amend',
}

for key, command in pairs(commits) do
  vim.keymap.set('n', key, '<Cmd>' .. command .. '<CR>', { buffer = true })
end
