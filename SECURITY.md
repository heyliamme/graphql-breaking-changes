# Security policy

The extension parses schemas you open, reads the other files of a split schema next to
them, runs `git` to read older versions, and renders the results in a webview. Bugs that
let the content of a schema run script in that webview, read files outside the schema's
folder or repository, or make `git` do anything other than read files at a ref are taken
seriously.

## Reporting

Please report vulnerabilities privately through
[GitHub security advisories](https://github.com/heyliamme/graphql-breaking-changes/security/advisories/new),
not public issues. Include steps to reproduce. You should hear back within a week.

## Scope

In scope: script execution or HTML injection from schema content (names, descriptions,
default values, directive arguments, file names), reading files through the
`schemaFiles` pattern outside the schema's folder (symbolic links included), option or
command injection through refs or settings, and anything that sends data off the machine.
