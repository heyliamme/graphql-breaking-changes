# Changelog

## 0.1.0

First release.

- Compares two versions of a GraphQL schema and reports what changed for API clients:
  breaking, dangerous and other changes, each with a stable id. 87 kinds of change across
  root types, types, fields, arguments, input objects, enums, unions, interfaces,
  directive definitions and applied directives, judged by direction: what the client
  reads (a field becoming non-null is safe) against what it sends (an argument becoming
  non-null is breaking), nullability at any depth, defaults, deprecations, `@specifiedBy`,
  `@oneOf`, descriptions.
- Reads SDL, schemas split across files with their `extend type` extensions (a glob
  relative to the file being compared, `.graphql`, `.graphqls` and `.gql` by default, read at the same Git version, so a deleted file's
  types count as removed), and introspection results (`schema.json`), on either side; an
  introspection result against the SDL it came from has no changes. Federation subgraphs
  read as they are, without directive definitions or the types they extend.
- Compare with HEAD, any branch, tag or commit, another schema in the workspace, two files
  in the Explorer (the old one told by the names, else you're asked), or the two sides of
  a diff editor. Schemas are recognised by content.
- Report grouped by type, with level filters, search, the field each change is about,
  links to the line in the old and the new schema (or the entry in an introspection JSON),
  and a Markdown changelog for pull requests.
- Release notes for clients between two tags, or the last tag and the working copy,
  grouped Breaking / Dangerous / Added / Changed, as Markdown.
- Optional Problems panel check against a baseline ref (`graphqlBreakingChanges.baseRef`),
  with quick fixes to open the report or ignore a change; changes in the other files of a
  split schema show on those files, a part of a split schema open on its own is checked
  as the whole schema, removals show on what is left of them (a removed field on its
  type), and a ref that names nothing, a schema that doesn't parse or can't be read at the
  ref, Git that can't run, or a split schema read only in part is reported instead of
  leaving the panel empty.
- Comparisons run in a worker thread: a large schema never holds up the editor. GitHub's
  public schema compares with an older version in a fifth to a third of a
  second.
- Ignore rules by id, type and field; warnings as errors; settings per folder in
  multi-root workspaces. In Restricted Mode, the workspace's ignore rules, baseline and
  schema file pattern are not applied and Git doesn't run; comparing files still works.
