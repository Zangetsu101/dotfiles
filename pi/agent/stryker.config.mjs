export default {
  mutate: ['extensions/lib/task-check-in.ts', 'extensions/lib/background-family.ts'],
  testRunner: 'tap',
  plugins: ['@stryker-mutator/tap-runner'],
  tap: {
    testFiles: ['tests/task-check-in.test.ts', 'tests/background-check-in-loader.test.ts', 'tests/background-family.test.ts', 'tests/background-family-context.test.ts'],
    nodeArgs: ['--experimental-strip-types', '--test-reporter=tap', '-r', '{{hookFile}}', '{{testFile}}'],
    forceBail: false,
  },
  // Node strips types without tsconfig; omit it to avoid Stryker's TS 5 compiler API rewrite.
  ignorePatterns: ['evals', 'reports', '.stryker-tmp', 'tsconfig.json'],
  coverageAnalysis: 'perTest',
  concurrency: 2,
  timeoutMS: 3000,
  timeoutFactor: 2,
  reporters: ['clear-text', 'json', 'html'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  htmlReporter: { fileName: 'reports/mutation/index.html' },
};
