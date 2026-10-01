# Vault rename state audit

`parachute-vault rename old new --yes` is an offline filesystem operation.
Like `remove`, it neither probes nor controls the daemon. The hub stops and
restarts the module around the command. Standalone callers must stop the
server and any export/import process first. There is no cross-process lock
against concurrent writers or concurrent renames, and no crash-atomic
transaction across SQLite, YAML, and services.json. Caught failures restore
state; the printed backup supports manual recovery after a process crash.
See `parachute-vault rename --help` for recovery steps.

Add `--json` for hub integration: a confirmed success writes one JSON object
`{"old":"old","new":"new","backup_path":"/absolute/path"}` to stdout;
human progress, warnings, and the cleanup reminder go to stderr. Preview mode
still requires `--yes` to perform the rename and emits no success object.

Filesystem rewrites match only the exact moved `vaultDir(old)` prefix followed
by `/` or the end of the value. Sibling vaults and external paths are unchanged,
even when the old name is `data` or `logs`. Route rewrites require an HTTP(S)
URL whose path starts with `/vault/old` at a route boundary. They apply only to
URL-valued config scalars and `triggers.action.webhook`, and only for loopback
hosts (`localhost`, `127.0.0.1`, `::1`) or configured public hub origins from
`PARACHUTE_HUB_ORIGIN` / `PARACHUTE_HUB_ORIGINS` in the command's environment.
Webhooks targeting other hosts remain unchanged. History and attachment paths
receive only the filesystem rewrite.

The backup uses SQLite `VACUUM INTO` before the move, including committed WAL
content. It includes vault and mirror YAML, history state when present, and
original global configuration/registration files. Assets are moved, not copied.
The directory is renamed with `renameSync`; the original YAML is passed through
`readVaultConfig`/`writeVaultConfig`'s name-only mode to preserve every other
field, including unknown fields and raw private-tag representations.

Audit of `vaultDir(`, `vaultDbPath(`, `assetsDir(`, `default_vault`, global
configuration types/readers/writers, and other vault-name maps:

| State / consumers | Handling |
| --- | --- |
| `vault.db`, notes, tags, links, note versions, history import receipts/runs/refs | Move intact; note paths are logical paths, not filesystem roots. History hashes/commit IDs remain intact. |
| `attachments.path`; routes, attachment bytes/tickets, transcription, triggers, mirror import/export | Uploads store date/file paths relative to `assetsDir(name)`. Move `assets/` intact; route test serves its bytes under the new name. Legacy absolute references within the moved root are rebased. Relative filenames containing the old name remain valid and unchanged. |
| `assetsDir` override (`ASSETS_DIR`) | External/shared roots stay where they are. Persisted `.env` references inside the moved root are rebased. Supervisor-provided environment overrides must be updated by the supervisor; this CLI cannot change another process's environment. |
| `vault.yaml` | Only `name` changes; other fields and YAML text survive. |
| `tokens.vault_name`, `oauth_codes.vault_name`, `mcp_mint_ledger.vault_name` | Exact old bindings become new; NULL/other bindings stay intact. Stored narrowed scopes in tokens/ledger also change. No schema migration is run. |
| Runtime triggers in SQLite; static global triggers | Rows move with the DB. Vault-route references in webhook actions/global config are rebased. Tag predicates and note IDs are unchanged. Runtime hook registrations rebuild on restart. Signed webhook bearer credentials cannot be reissued locally. |
| Internal mirror and `.mirror-credentials.yaml` | Move with the vault. Credentials and Git remote repository identity remain unchanged. Internal mirror path is derived from the new vault directory. |
| `mirror-config.yaml`, legacy global mirror block | Absolute paths within the moved root are rebased; operator-owned external repositories stay put. Exported `.parachute/vault.yaml` is a derived snapshot refreshed by the next export; historical Git commits/archives remain historical snapshots. |
| Export-watch | CLI arguments and in-memory options, no persisted vault-name registry. Stop/relaunch any standalone watcher with the new name. External exports are snapshots, not live vault state. |
| History import | Refuse while paused, locked, or carrying unfinished recovery state: external manifests bind name and database hash and cannot safely be rewritten. Retired state/recovery paths inside the moved root are rebased; internal backups move intact. External manifests remain historical artifacts. |
| Global `config.yaml` | Update matching `default_vault`; preserve other keys and unknown fields verbatim. No other supported global config map is keyed by vault name. Rebase moved-root paths (including backup destinations) and vault-route URLs. |
| `.env` | Rebase moved-root paths and route URLs; update matching `PARACHUTE_VAULT_NAME` (first-boot setting). Other values stay intact. |
| `services.json` | `selfRegister` recomputes paths/health, preserving sibling rows and hub metadata. Failed registration is fatal and triggers rollback; a missing module manifest skips registration with a warning. |
| Store/reverse-store, mirror registry, usage cache, live triggers, WS/subscriptions, attachment tickets, mirror import/device-flow jobs | In-memory maps, rebuilt or discarded on the required restart. |
| Backup snapshots, logs, external client MCP configs and hub JWTs/grants | Historical/operator- or hub-owned state. Do not rewrite archives/logs or signed tokens. The hub rename flow owns grants and clients need the new route. |

Rollback restores the original directory, YAML/history files, SQLite snapshot,
and any modified global files (including their prior absence). Rollback errors
are reported separately with the backup path; the command never claims success
if registration fails. Backup directories are private and retained for recovery. Once the rename is
verified, the printed backup under `.rename-backups/` can be deleted. Vault
discovery excludes dot-directories, and usage walks skip `.rename-backups/`.
