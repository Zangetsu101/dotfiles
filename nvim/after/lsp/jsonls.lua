return {
  json = {
    schemas = require('schemastore').json.schemas {
      select = {
        '.eslintrc',
        'lerna.json',
        'package.json',
        'prettierrc.json',
        'tsconfig.json',
        'tslint.json',
      },
      replace = {
        ['tsconfig.json'] = {
          description = 'JSON schema for typescript configuration files',
          fileMatch = { 'tsconfig*.json' },
          name = 'tsconfig.json',
          url = 'https://json.schemastore.org/tsconfig.json',
        },
      },
    },
  },
}
