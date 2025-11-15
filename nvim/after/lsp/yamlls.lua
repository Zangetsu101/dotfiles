return {
  json = {
    schemas = require('schemastore').json.schemas {
      select = {
        'docker-compose.yml',
      },
    },
  },
}
