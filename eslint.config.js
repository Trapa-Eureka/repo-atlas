import tseslint from "typescript-eslint";

// Layers, lowest first. A folder may import from folders listed before it, never from ones after it.
// These rules replace prose in CLAUDE.md: when one fires, fix the design instead of silencing the rule.
const LAYERS = {
  graph: { mayImport: [] },
  extract: { mayImport: [] },
  store: { mayImport: ["graph", "extract"] },
  indexer: { mayImport: ["graph", "extract", "store"] },
  query: { mayImport: ["graph"] },
  app: { mayImport: ["graph", "extract", "store", "indexer", "query"] },
  mcp: { mayImport: ["graph", "extract", "store", "indexer", "query", "app"] },
  cli: { mayImport: ["graph", "extract", "store", "indexer", "query", "app", "mcp"] },
};

// Third-party and built-in modules that only one layer may touch.
const OWNED_MODULES = {
  "node:sqlite": { owner: "store", why: "Only src/store talks to SQLite. Add a method to Store and call that." },
  "web-tree-sitter": { owner: "extract", why: "Only src/extract parses source. Return plain facts from an extractor instead." },
  commander: { owner: "cli", why: "Argument parsing belongs to src/cli. Put the behaviour in src/app and call it from the command." },
};

const layerConfigs = Object.entries(LAYERS).map(([layer, { mayImport }]) => {
  const banned = Object.keys(LAYERS).filter((other) => other !== layer && !mayImport.includes(other));
  return {
    files: [`src/${layer}/**/*.ts`],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            ...banned.map((other) => ({
              group: [`**/${other}/*`],
              message: `src/${layer} must not depend on src/${other} (allowed: ${mayImport.join(", ") || "nothing"}). Move the shared piece down a layer, or do this work in src/app.`,
            })),
            { group: ["@modelcontextprotocol/*"], message: "Only src/mcp speaks the MCP protocol. Expose the behaviour on Atlas (src/app) and wrap it in a tool there." },
          ].filter((pattern) => !(layer === "mcp" && pattern.group[0] === "@modelcontextprotocol/*")),
          paths: Object.entries(OWNED_MODULES)
            .filter(([, { owner }]) => owner !== layer)
            .map(([name, { why }]) => ({ name, message: why })),
        },
      ],
    },
  };
});

export default tseslint.config(
  { ignores: ["dist/", "fixtures/", "docs/", "node_modules/", ".atlas/"] },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-console": ["error"],
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='process'][callee.property.name='exit']",
          message: "Do not call process.exit: it drops buffered output and skips Store.close(). Throw an Error, or return an exit code from run().",
        },
      ],
    },
  },
  ...layerConfigs,
);
