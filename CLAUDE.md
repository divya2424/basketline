# Engineering Rules — Minimal Correct Code

## Priorities
1. Correctness and security.
2. Smallest complete solution.
3. Readability and maintainability.
4. Performance when relevant.
5. Extensibility only when explicitly needed.

## Before coding
- Inspect relevant files, callers, tests, and existing conventions.
- Search for existing utilities and equivalent logic before adding new code.
- Identify the smallest correct change.
- Ask a question only when an ambiguity materially affects correctness.

## Anti-overengineering rules
- Do not refactor unrelated code.
- Do not add unrequested features, dependencies, configuration, or architecture.
- Do not create classes, wrappers, factories, interfaces, managers, or helpers without a concrete benefit.
- Do not duplicate existing logic.
- Do not rewrite entire files when a localized edit is sufficient.
- Do not add speculative fallback paths, redundant validation, or comments that restate code.
- Prefer straightforward control flow over clever or generic solutions.
- Do not optimize for line count at the expense of clarity, correctness, security, or required error handling.

## Scope and verification
- Change only files needed for the requested behavior.
- Preserve existing APIs, data contracts, and behavior unless the task requires a change.
- If the implementation must expand substantially, explain why.
- Run relevant tests, lint, formatting, and type checks that are available.
- Never claim a check passed unless it actually ran and passed.
- Do not weaken tests or checks merely to make a change pass.

## Final response
- Summarize what changed in a few bullets.
- Show the relevant diff rather than dumping entire files.
- State checks actually run and any remaining risks.
