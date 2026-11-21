# WeNote API

The Go API serves the Phase 1 desktop and web clients.

- `internal/sqlite` opens SQLite with foreign keys enabled and applies the initial schema for users, sessions, Vaults, devices, files, versions, changes, blobs, and upload sessions.
- `internal/blob` writes content-addressed Local Blob files through a temporary file and atomic rename after checking the declared size and SHA-256.
- `internal/model` defines the protocol-shaped core objects and sync request fields.
- `internal/password` stores passwords as salted PBKDF2-HMAC-SHA256 records and compares them in constant time.
- `internal/store` persists users, sessions, Vault ownership, devices, upload sessions, file versions, changes, and sync idempotency records with user-scoped queries.
- `internal/httpapi` exposes health, registration, login, current-user, Vault, device, file, upload-session, and sync endpoints.

The API exposes the following routes.

```text
POST   /api/v1/auth/register
POST   /api/v1/auth/login
POST   /api/v1/auth/refresh
POST   /api/v1/auth/logout
GET    /api/v1/config
GET    /api/v1/me
GET    /api/v1/vaults
POST   /api/v1/vaults
GET    /api/v1/vaults/{vault_id}
GET    /api/v1/vaults/{vault_id}/files
GET    /api/v1/vaults/{vault_id}/files/{file_id}
GET    /api/v1/vaults/{vault_id}/files/{file_id}/content
GET    /api/v1/vaults/{vault_id}/files/{file_id}/versions
GET    /api/v1/vaults/{vault_id}/files/{file_id}/versions/{version_id}
POST   /api/v1/vaults/{vault_id}/files
PUT    /api/v1/vaults/{vault_id}/files/{file_id}/content
PATCH  /api/v1/vaults/{vault_id}/files/{file_id}
DELETE /api/v1/vaults/{vault_id}/files/{file_id}
POST   /api/v1/vaults/{vault_id}/files/{file_id}/restore
GET    /api/v1/vaults/{vault_id}/files/{file_id}/versions/{version_id}/content
GET    /api/v1/vaults/{vault_id}/trash
POST   /api/v1/vaults/{vault_id}/assets/uploads
POST   /api/v1/vaults/{vault_id}/assets/{asset_id}/complete
GET    /api/v1/vaults/{vault_id}/assets/{asset_id}
DELETE /api/v1/vaults/{vault_id}/assets/{asset_id}
GET    /assets/{asset_id}
POST   /api/v1/shares
GET    /api/v1/shares/sent
GET    /api/v1/shares/inbox
POST   /api/v1/shares/{share_id}/accept
POST   /api/v1/shares/{share_id}/reject
DELETE /api/v1/shares/{share_id}
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

The file tree lists active files in path order. File content reads return the current Blob bytes with `X-Content-Hash` and `X-Version-Id` headers. Version history is returned newest first.

Run the tests from this directory with `go test ./...`. Start the development server with `go run ./cmd/wenote-api`. The server stores local blobs under `./data/storage` by default and accepts `-blobs` to change that path.

File creation accepts `path` and a base64 `content` string. Editing, moving, deleting and restoring take `base_version_id` or `base_content_hash`. Clients can send `base_path` to detect a concurrent move and `Idempotency-Key` to replay an acknowledged write. The write response includes the file ID, path, version, content hash and Vault revision. The JSON file write endpoint accepts notes up to 16 MiB. Asset uploads accept up to 256 MiB and verify the declared size and digest before completion.

### Resumable attachments

Create the asset with `POST /api/v1/vaults/{vault_id}/assets/uploads`, retaining the same `Idempotency-Key` on retry. For a pending asset, use these endpoints under `/api/v1/vaults/{vault_id}/assets/{asset_id}` with the same vault write credentials.

| Request | Response |
| --- | --- |
| `GET /parts` | Returns `part_size`, `completed_parts` (zero-based indices), and `status`. |
| `PUT /parts/{number}` | Accepts the raw bytes, an exact `Content-Range: bytes start-end/total`, and `X-Part-Hash: sha256:<hex>`. Identical retries return 204. Conflicting bytes for an accepted part return 409. |
| `POST /assemble` | Verifies all parts in order and publishes the original blob. Success and replay return 204. Missing parts or a mismatched SHA-256 return 409. |

The staging lease lasts 24 hours from the most recent accepted part. After expiry clients can send all parts again with the same asset ID. Expired rows are reclaimed when new parts arrive. Whole-body `POST /complete` continues to accept existing clients.
