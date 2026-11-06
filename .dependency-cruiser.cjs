module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    { name: "no-unresolved", severity: "error", from: {}, to: { couldNotResolve: true } },
    {
      name: "domain-only-domain",
      severity: "error",
      from: { path: "^src/domain/" },
      to: { pathNot: "^src/domain/" },
    },
    {
      name: "application-inward-only",
      severity: "error",
      from: { path: "^src/application/" },
      to: { pathNot: "^src/(domain|application)/" },
    },
    {
      name: "infrastructure-not-presentation",
      severity: "error",
      from: { path: "^src/infrastructure/" },
      to: { path: "^extensions/" },
    },
  ],
  options: {
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "node", "default"],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    doNotFollow: { path: "node_modules" },
  },
};
