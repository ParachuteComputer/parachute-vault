# External packs (Bun CLI)

A vault pack is a data shape: tags, fields and starter notes. A hub module is
the full bundle of data, interface and connector; the hub hands its data part
to the vault through this mechanism.

```sh
parachute-vault packs add ./calendar --vault personal
parachute-vault packs add https://example.com/calendar/pack.json --vault personal
parachute-vault packs list --vault personal
parachute-vault packs remove calendar --vault personal
```

`add-pack ./calendar/pack.json --vault personal` is an alias for external
installation. Built-in names still use the existing SeedPack behavior.

A directory contains pack.yaml or pack.json (legacy module.yaml/module.json
are also accepted), with id, name, version,
description, SeedPack tags and notes; requires, views and connector are
optional. Stable versions use MAJOR.MINOR.PATCH. Dependencies are pack ids.
Views declare a kind. Connectors declare run, scope {tags, verbs}, publishes.
Both fields are accepted as inert hub module data; the vault never installs
interfaces, executes connectors or downloads code.

Notes are created only at vacant paths. Existing notes are never overwritten.
Existing tag shapes are preserved unless unchanged since this pack wrote
them. Differences are printed as DIFF; resolve them deliberately. Increasing
version upgrades owned schemas; downgrade or a changed same-version manifest
is rejected. Repeating an identical install leaves data untouched.

Removal clears only unchanged, unshared, installer-owned fields/parents.
Tag identities, descriptions, assignments and all notes survive. Dependents
block removal. Edited or borrowed schemas remain with a report.

Lifecycle state lives beside each vault.db in packs/<id>.json. Include this
directory in backups; portable Markdown export does not include registration.
A .lock directory serializes pack CLI operations. Failed operations are
resumable but not atomic; interrupted processes may leave an empty lock to
remove after verifying that the process exited. REST/MCP schema edits are
not serialized with the CLI, so avoid concurrent administrative schema edits.
Legacy modules/ registrations migrate once to packs/ on the next pack command;
conflicting registrations are preserved and reported for manual resolution.
The running daemon checks SQLite data_version before using schema/hierarchy
caches. CLI installs and removals become visible on the next cache access,
without a restart or an admin reload request. Indexed field queries read their
catalog directly from SQLite. Vault descriptions/projections and MCP tool
catalogs are built per request; an already delivered MCP initialization brief
is refreshed by reconnecting or querying vault-info.
Pending installs do not satisfy dependencies and are omitted from packs list.

URL manifests are capped at 1 MiB with a 15-second timeout. Prefer reviewed
local manifests or HTTPS. No signed package distribution, credential minting,
connector supervision, asset hosting or cloud/MCP pack install is included.
