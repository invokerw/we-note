# WeNote API foundation

This package contains the first Phase 1 server slices.

- `internal/sqlite` opens SQLite with foreign keys enabled and applies the initial schema for users, sessions, Vaults, devices, files, versions, changes, blobs, and upload sessions.
- `internal/blob` writes content-addressed Local Blob files through a temporary file and atomic rename after checking the declared size and SHA-256.
- `internal/model` defines the protocol-shaped core objects and sync request fields.
- `internal/password` stores passwords as salted PBKDF2-HMAC-SHA256 records and compares them in constant time.
- `internal/store` persists users, sessions, Vault ownership, devices, upload sessions, file versions, changes, and sync idempotency records with user-scoped queries.
- `internal/httpapi` exposes health, registration, login, current-user, Vault, device, upload-session, and sync endpoints.

The current authenticated endpoints are:

```text
POST   /api/v1/auth/register
POST   /api/v1/auth/login
GET    /api/v1/me
GET    /api/v1/vaults
POST   /api/v1/vaults
GET    /api/v1/vaults/{vault_id}
GET    /api/v1/devices
POST   /api/v1/devices
DELETE /api/v1/devices/{device_id}
POST   /api/v1/vaults/{vault_id}/sync/upload-sessions
GET    /api/v1/vaults/{vault_id}/sync/upload-sessions/{upload_id}
POST   /api/v1/vaults/{vault_id}/sync/upload-sessions/{upload_id}/complete
POST   /api/v1/vaults/{vault_id}/sync/changes
GET    /api/v1/vaults/{vault_id}/sync/manifest
```

Upload sessions accept a declared SHA-256 and size, then verify the raw request bytes before marking the session completed. A completed `upload_id` is submitted through `sync/changes`.

Run the tests from this directory with `go test ./...`. Start the development server with `go run ./cmd/wenote-api`. The server stores local blobs under `./data/storage` by default and accepts `-blobs` to change that path.
