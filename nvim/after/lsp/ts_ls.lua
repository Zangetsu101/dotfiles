-- Native tsc (TS >= 7) speaks LSP via `tsc --lsp`; older projects fall back
-- to typescript-language-server.
local function ts_version(root_dir)
  local pkg = vim.fs.joinpath(root_dir, "node_modules", "typescript", "package.json")
  local f = io.open(pkg)
  if not f then
    return nil
  end
  local ok, data = pcall(vim.json.decode, f:read("*a"))
  f:close()
  if not ok or type(data) ~= "table" then
    return nil
  end
  return tonumber((data.version or ""):match("^(%d+)"))
end

return {
  cmd = function(dispatchers, config)
    local root_dir = config.root_dir or vim.fn.getcwd()
    local major = ts_version(root_dir)
    local cmd
    if major and major >= 7 then
      cmd = { "tsc", "--lsp", "--stdio" }
    else
      cmd = { "typescript-language-server", "--stdio" }
    end
    return vim.lsp.rpc.start(cmd, dispatchers)
  end,
}
