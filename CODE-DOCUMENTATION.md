# Code documentation

Docblocks are a reading aid, not a comment-count target.

- Give each handwritten JS/TS module a short purpose overview: `@file` for
  JavaScript and `@packageDocumentation` for TypeScript, on their own tag lines.
- Document named functions, internal helpers, hooks/components, classes and
  shared types/contracts, including tooling and test helpers. Put wrapped
  component documentation above its named declaration/export.
- Lead with purpose and behaviour. Explain meaningful inputs, results, errors,
  side effects, units, security constraints and assumptions. Use `@param`,
  `@returns`, `@throws` and `@remarks` when they make the contract clearer;
  preserve any stricter tag-presence requirements in the repository's lint rules.
- Do not repeat TypeScript types. Keep useful JavaScript type annotations.
- Explain non-obvious decisions beside the relevant code. Keep architecture,
  setup and operational history in their owning documentation.
- Ordinary anonymous callbacks and declarative test cases do not each need a
  docblock. Named test helpers do. Generated files and build artifacts are exempt,
  not difficult handwritten code.
- Update comments with behaviour changes. TODOs need a concrete reason or removal
  condition, preferably an issue reference.

`eslint.config.mjs` owns blocking automated checks;
`tests/tooling/documentation.test.ts` guards their behaviour. Human review must
still check usefulness and accuracy: valid syntax does not prove a true comment.
