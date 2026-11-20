# WeNote API foundation

This package contains the first Phase 1 server foundation.

- `internal/sqlite` opens SQLite with foreign keys enabled and applies the initial schema for users, Vaults, devices, files, versions, changes, blobs, and upload sessions.
- `internal/blob` writes content-addressed Local Blob files through a temporary file and atomic rename after checking the declared size and SHA-256.
- `internal/model` defines the protocol-shaped core objects and sync request fields.
- `internal/httpapi` currently exposes `GET /healthz` while the authenticated API handlers are added in later slices.

Run the tests from this directory with `go test ./...`.
