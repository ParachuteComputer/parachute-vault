# External modules (Bun CLI)

```sh
parachute-vault modules add ./calendar --vault personal
parachute-vault modules add https://example.com/calendar/module.json --vault personal
parachute-vault modules list --vault personal
parachute-vault modules remove calendar --vault personal
```

`add-pack ./calendar/module.json --vault personal` is an alias for external
installation. Built-in names still use the existing SeedPack behavior.

A directory contains module.yaml or module.json, with id, name, version,
description, SeedPack tags and notes; requires, views and connector are
optional. Stable versions use MAJOR.MINOR.PATCH. Dependencies are module ids.
Views declare a kind. Connectors declare run, scope {tags, verbs}, publishes;
the CLI records these but never executes commands or downloads code.

Notes are created only at vacant paths. Existing notes are never overwritten.
Existing tag shapes are preserved unless unchanged since this module wrote
them. Differences are printed as DIFF; resolve them deliberately. Increasing
version upgrades owned schemas; downgrade or a changed same-version manifest
is rejected. Repeating an identical install leaves data untouched.

Removal clears only unchanged, unshared, installer-owned fields/parents.
Tag identities, descriptions, assignments and all notes survive. Dependents
block removal. Edited or borrowed schemas remain with a report.

Lifecycle state lives beside each vault.db in modules/<id>.json. Include this
directory in backups; portable Markdown export does not include registration.
A .lock directory serializes module CLI operations. Failed operations are
resumable but not atomic; interrupted processes may leave an empty lock to
remove after verifying that the process exited. REST/MCP schema edits are
not serialized with the CLI, so avoid concurrent administrative schema edits.
The daemon has process-local schema/hierarchy caches; CLI writes cannot
invalidate already-loaded caches. A serving-process lifecycle API is needed
for reliable refresh of every validation/default/hierarchy path.
Pending installs do not satisfy dependencies and are omitted from modules list.

URL manifests are capped at 1 MiB with a 15-second timeout. Prefer reviewed
local manifests or HTTPS. No signed package distribution, credential minting,
connector supervision, asset hosting or cloud/MCP module install is included.
