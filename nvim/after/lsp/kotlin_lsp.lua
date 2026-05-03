local lspconfig = require 'lspconfig'

return {
  default_config = {
    cmd = { '/home/tameem/.cargo/bin/kotlin-lsp' },
    filetypes = { 'kotlin', 'java', 'swift' },
    root_dir = lspconfig.util.root_pattern(
      'build.gradle',
      'build.gradle.kts',
      'pom.xml',
      'settings.gradle',
      'Package.swift',
      '.git'
    ),
  }
}
