# WeNote API foundation

This package contains the first Phase 1 server slices.

- `internal/sqlite` opens SQLite with foreign keys enabled and applies the initial schema for users, sessions, Vaults, devices, files, versions, changes, blobs, and upload sessions.
- `internal/blob` writes content-addressed Local Blob files through a temporary file and atomic rename after checking the declared size and SHA-256.
- `internal/model` defines the protocol-shaped core objects and sync request fields.
- `internal/password` stores passwords as salted PBKDF2-HMAC-SHA256 records and compares them in constant time.
- `internal/store` persists users, sessions, Vault ownership, and devices with user-scoped queries.
- `internal/httpapi` exposes health, registration, login, current-user, Vault, and device endpoints.

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
```

Run the tests from this directory with `go test ./...`. Start the development server with `go run ./cmd/wenote-api`.
