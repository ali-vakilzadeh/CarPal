// Module boundaries of the modular monolith (41 §1 rules 1-2, §4.2).
// pnpm lint fails on any violation.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'module-internals',
      comment:
        'A module may use another module only through its interface/ folder or its <name>.module.ts (41 §4.2). ' +
        'domain/, application/, infrastructure/, api/, events/ and projections/ are private.',
      severity: 'error',
      from: { path: '^modules/([^/]+)/' },
      to: {
        path: '^modules/([^/]+)/(?!interface/|[^/]+\\.module\\.ts$)',
        pathNot: '^modules/$1/',
      },
    },
    {
      name: 'libs-are-leaves',
      comment: 'Platform libraries have no business rules and never depend on modules, apps or workers (41 §2.2).',
      severity: 'error',
      from: { path: '^libs/' },
      to: { path: '^(modules|apps|workers)/' },
    },
    {
      name: 'modules-not-apps',
      comment: 'Modules are composed by apps and workers, never the other way round.',
      severity: 'error',
      from: { path: '^modules/' },
      to: { path: '^(apps|workers)/' },
    },
    {
      name: 'runtime-not-tools',
      comment: 'Deployable code must not import build/dev tooling (tests may).',
      severity: 'error',
      from: { path: '^(apps|libs|modules|workers)/', pathNot: '\\.test\\.ts$' },
      to: { path: '^tools/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'not-to-dev-dep',
      comment: 'Deployable code must not depend on devDependencies.',
      severity: 'error',
      from: { path: '^(apps|libs|modules|workers)/', pathNot: '\\.test\\.ts$' },
      to: { dependencyTypes: ['npm-dev'], pathNot: 'node_modules/@types/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|\\.data|\\.tools|generated)/' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      // package.json "imports" (#libs/*, ...) resolve to sources with the "source" condition.
      conditionNames: ['source', 'import', 'node', 'default'],
      extensions: ['.ts', '.js', '.json'],
      exportsFields: ['exports'],
      mainFields: ['module', 'main', 'types'],
    },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
