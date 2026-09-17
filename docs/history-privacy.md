# History provenance visibility

Tag-restricted sessions can read the versions of notes currently visible to them,
but REST and scoped MCP omit the top-level `actor` and `via` fields from both
version lists and individual native/imported version reads. Imported `origin`
and `import_ix`, native indices, timestamps, operations and content remain usable.

This is a response projection, not a storage migration. Unrestricted sessions,
including administrators, retain provenance. An administrator using a
tag-restricted token still receives the restricted projection. An empty tag
list retains its existing unrestricted meaning. Read/write/admin verb checks
and note visibility checks remain unchanged.

This does not anonymize user-authored content or metadata, nor change live-note
attribution or restore permissions. Historical identities written into a note's
body remain part of that note. Deleted-note and missing-version rules are unchanged.

Hosted consumers must apply the same core `projectHistoryProvenance` projection
after establishing note visibility. This change wires the self-hosted REST/MCP
doors; it does not claim hosted history support is already implemented.

Policy approved by Aaron on 2026-09-17; resolves the tag-scoped disclosure
decision in vault#736.
