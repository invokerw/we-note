package store

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/weifei/we-note/services/api/internal/blob"
	"github.com/weifei/we-note/services/api/internal/sqlite"
)

func TestGMStorageMigrationAndRemoteBackup(t *testing.T) {
	for _, kind := range []string{"webdav", "s3"} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			root := t.TempDir()
			db, err := sqlite.Open(ctx, filepath.Join(root, "db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err = db.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			local, _ := blob.NewLocalStore(filepath.Join(root, "live"))
			repo := NewRepository(db, local)
			_, err = db.Exec(`INSERT INTO users(id,email,password_hash,created_at,role) VALUES('owner','test@example.test','hash',CURRENT_TIMESTAMP,'system_admin'); INSERT INTO vaults(id,owner_user_id,name,created_at) VALUES('v','owner','notes',CURRENT_TIMESTAMP)`)
			if err != nil {
				t.Fatal(err)
			}
			text := "note before migration"
			hash := fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(text)))
			size := int64(len(text))
			key, err := local.PutAt(ctx, "users/owner/vaults/v", hash, size, time.Date(2025, 1, 7, 0, 0, 0, 0, time.UTC), strings.NewReader(text))
			if err != nil {
				t.Fatal(err)
			}
			_, err = db.Exec(`INSERT INTO blobs VALUES('b','v',?,?,?,CURRENT_TIMESTAMP)`, hash, size, key)
			if err != nil {
				t.Fatal(err)
			}
			objects := map[string]string{}
			failReads := false
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if kind == "webdav" {
					u, p, _ := r.BasicAuth()
					if u != "account" || p != "secret" {
						w.WriteHeader(401)
						return
					}
				} else if !strings.Contains(r.Header.Get("Authorization"), "Credential=account/") {
					w.WriteHeader(403)
					return
				}
				switch r.Method {
				case "MKCOL":
					w.WriteHeader(201)
				case "PUT":
					b, _ := io.ReadAll(r.Body)
					objects[r.URL.Path] = string(b)
				case "GET":
					if failReads {
						w.WriteHeader(503)
						return
					}
					b, ok := objects[r.URL.Path]
					if !ok {
						w.WriteHeader(404)
						return
					}
					io.WriteString(w, b)
				case "DELETE":
					delete(objects, r.URL.Path)
					w.WriteHeader(204)
				default:
					w.WriteHeader(405)
				}
			}))
			defer srv.Close()
			const encryptedID = "ef721403-7744-4dd2-937a-3db614f6bd33"
			envelope := Envelope{IV: make([]byte, 12), Ciphertext: []byte("encrypted content predating GM")}
			if _, err = db.Exec(`INSERT INTO encrypted_vaults VALUES(?,?,1,?,?,CURRENT_TIMESTAMP)`, encryptedID, "owner", envelope.Ciphertext, envelope.IV); err != nil {
				t.Fatal(err)
			}
			profile := StorageConfig{Kind: kind, Endpoint: srv.URL, Username: "account", Secret: "secret", Bucket: "bucket", Region: "us-east-1"}
			if err := repo.ConfigureStorage(ctx, "owner", "online", profile); err != nil {
				t.Fatal(err)
			}
			var inlineBytes int
			if err = db.QueryRow(`SELECT length(ciphertext) FROM encrypted_vaults WHERE id=?`, encryptedID).Scan(&inlineBytes); err != nil || inlineBytes != 0 {
				t.Fatal("existing encrypted vault was not moved", inlineBytes, err)
			}
			envelope.Base = 1
			envelope.IV[0] = 1
			envelope.Ciphertext = []byte("encrypted vault revised after migration")
			if _, err = repo.SaveEncrypted(ctx, "owner", encryptedID, envelope); err != nil {
				t.Fatal(err)
			}
			if _, err = repo.SaveEncrypted(ctx, "owner", encryptedID, envelope); err != nil {
				t.Fatal("retry", err)
			}
			if err := repo.SetSetting(ctx, "owner", "backup_root", filepath.Join(root, "backups")); err != nil {
				t.Fatal(err)
			}
			if err := repo.ConfigureStorage(ctx, "owner", "backup", profile); err != nil {
				t.Fatal(err)
			}
			job, err := repo.CreateBackup(ctx, "owner")
			if err != nil {
				t.Fatal(err)
			}
			if err = os.Remove(job.Path); err != nil {
				t.Fatal(err)
			}
			fresh := NewRepository(db, local)
			fresh.SetSettingsKey(repo.settingsKey)
			if err := fresh.LoadOnlineStorage(ctx); err != nil {
				t.Fatal(err)
			}
			if err := fresh.ConfigureStorage(ctx, "owner", "backup", StorageConfig{Kind: "local"}); err != nil {
				t.Fatal(err)
			}
			catalog, err := fresh.StorageCatalog(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if err = fresh.SaveStorageProfile(ctx, "owner", "", "备用位置", StorageConfig{Kind: "local", Directory: filepath.Join(root, "unused")}, catalog.Revision); err != nil {
				t.Fatal(err)
			}
			if err := fresh.VerifyBackup(ctx, job.ID); err != nil {
				t.Fatal(err)
			}
			if _, err = db.Exec(`UPDATE vaults SET current_revision=55 WHERE id='v'`); err != nil {
				t.Fatal(err)
			}
			failReads = true
			if _, err = fresh.ApplyBackup(ctx, "owner", job.ID); err == nil {
				t.Fatal("restore proceeded despite unreadable current contents")
			}
			var revision int64
			if err = db.QueryRow(`SELECT current_revision FROM vaults WHERE id='v'`).Scan(&revision); err != nil || revision != 55 {
				t.Fatal("live data changed after failed safety backup", revision, err)
			}
			failReads = false
			if _, err := fresh.ApplyBackup(ctx, "owner", job.ID); err != nil {
				t.Fatal(err)
			}
			after, err := fresh.StorageCatalog(ctx)
			if err != nil || after.Online != catalog.Online || after.Backup != catalog.Backup || after.Profiles[len(after.Profiles)-1].Name != "备用位置" {
				t.Fatal("current catalog lost after restore", err)
			}
			for _, p := range after.Profiles {
				if p.Secret != "" {
					t.Fatal("catalog exposed stored credentials")
				}
			}
			if _, err = fresh.PullSyncChanges(ctx, "v", "device", 55); err == nil {
				t.Fatal("pre-restore cursor still accepted")
			}
			v, err := fresh.EncryptedVault(ctx, "owner", encryptedID)
			if err != nil || string(v.Ciphertext) != string(envelope.Ciphertext) {
				t.Fatal("restored encrypted vault", err)
			}
			failReads = true
			dest := StorageConfig{Kind: "local", Directory: filepath.Join(root, "next")}
			if err := fresh.ConfigureStorage(ctx, "owner", "online", dest); err == nil {
				t.Fatal("migration should fail")
			}
			failReads = false
			pub, err := fresh.StorageSettings(ctx, "online")
			if err != nil || pub.Kind != kind || pub.Secret != "" || !pub.HasSecret {
				t.Fatal(pub.Kind, err)
			}
			if err := fresh.ConfigureStorage(ctx, "owner", "online", dest); err != nil {
				t.Fatal(err)
			}
			b, err := os.ReadFile(filepath.Join(dest.Directory, key))
			if err != nil || string(b) != text {
				t.Fatal("missing migrated note", err)
			}
		})
	}
}

func TestOwnedStorageAndAccountCleanup(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sqlite.Open(ctx, filepath.Join(root, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	local, _ := blob.NewLocalStore(root)
	r := NewRepository(db, local)
	admin, _ := r.CreateUser(ctx, "admin@test.test", "hash")
	alice, _ := r.CreateUser(ctx, "alice@test.test", "hash")
	bob, _ := r.CreateUser(ctx, "bob@test.test", "hash")
	content := "same bytes"
	hash := fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(content)))
	keys := map[string]string{}
	vaults := map[string]string{}
	for _, id := range []string{alice.ID, bob.ID} {
		v, err := r.CreateVault(ctx, id, "Notes")
		if err != nil {
			t.Fatal(err)
		}
		key, err := r.blobStore.PutAt(ctx, v.ID, hash, int64(len(content)), time.Now().UTC(), strings.NewReader(content))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.HasPrefix(key, "users/"+id+"/vaults/"+v.ID+"/") {
			t.Errorf("unscoped key %s", key)
		}
		keys[id] = filepath.Join(root, key)
		vaults[id] = v.ID
	}
	if _, err = r.WriteFile(ctx, alice.ID, vaults[alice.ID], "", "create_file", "", FileWrite{Path: "shared.md", Content: []byte("shared contents")}); err != nil {
		t.Fatal(err)
	}
	share, err := r.ShareFiles(ctx, alice.ID, "share", ShareRequest{Vault: vaults[alice.ID], Recipient: bob.Email, Paths: []string{"shared.md"}})
	if err != nil {
		t.Fatal(err)
	}
	imported, err := r.AcceptShare(ctx, bob.ID, share.ID, vaults[bob.ID], "imported")
	if err != nil || len(imported) != 1 {
		t.Fatal(imported, err)
	}
	if err = r.ChangeUserStatus(ctx, admin.ID, alice.ID, "delete", "", alice.Email); err != nil {
		t.Fatal(err)
	}
	if err = r.RunCleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(keys[alice.ID]); err != nil {
		t.Fatal("legacy account lost data", err)
	}
	if err = r.ChangeUserStatus(ctx, admin.ID, alice.ID, "purge", "", bob.Email); err == nil {
		t.Fatal("wrong confirmation accepted")
	}
	if err = r.ChangeUserStatus(ctx, admin.ID, alice.ID, "purge", "", alice.Email); err != nil {
		t.Fatal(err)
	}
	if err = r.RunCleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(keys[alice.ID]); !os.IsNotExist(err) {
		t.Fatal("deleted account kept object", err)
	}
	if _, err = os.Stat(keys[bob.ID]); err != nil {
		t.Fatal("other owner lost object", err)
	}
	_, in, err := r.OpenFileContent(ctx, vaults[bob.ID], imported[0].FileID)
	if err != nil {
		t.Fatal(err)
	}
	defer in.Close()
	data, err := io.ReadAll(in)
	if err != nil || string(data) != "shared contents" {
		t.Fatal("imported copy damaged", err)
	}
}

func TestTrashExpiryAndHistoricalReferences(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sqlite.Open(ctx, filepath.Join(root, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	local, _ := blob.NewLocalStore(root)
	r := NewRepository(db, local)
	user, err := r.CreateUser(ctx, "user@example.test", "hash")
	if err != nil {
		t.Fatal(err)
	}
	v, err := r.CreateVault(ctx, user.ID, "Notes")
	if err != nil {
		t.Fatal(err)
	}
	text := "attachment"
	hash := fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(text)))
	a, err := r.CreateAsset(ctx, user.ID, v.ID, "plain.txt", "text/plain", hash, "", int64(len(text)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = r.CompleteUploadSession(ctx, v.ID, a.Upload, strings.NewReader(text)); err != nil {
		t.Fatal(err)
	}
	var key string
	if err = db.QueryRow(`SELECT storage_key FROM blobs WHERE content_hash=?`, hash).Scan(&key); err != nil {
		t.Fatal(err)
	}
	newPath := filepath.Join(root, key)
	note, err := r.WriteFile(ctx, user.ID, v.ID, "", "create_file", "", FileWrite{Path: "note.md", Content: []byte(a.URL)})
	if err != nil {
		t.Fatal(err)
	}
	updated, err := r.WriteFile(ctx, user.ID, v.ID, note.FileID, "update_file_content", "", FileWrite{BaseVersion: note.Version, Content: []byte("current")})
	if err != nil {
		t.Fatal(err)
	}
	if err = r.DeleteAsset(ctx, user.ID, v.ID, a.ID); err != nil {
		t.Fatal(err)
	}
	date := a.CreatedAt.UTC().Format("2006/01/02")
	parts := strings.Split(date, "/")
	if _, err = r.AssetForPublicPath(ctx, user.ID, parts[0], parts[1], parts[2], strings.TrimPrefix(hash, "sha256:")); err != nil {
		t.Fatal("historical date-based attachment URL", err)
	}
	if _, err = r.AssetForUser(ctx, user.ID, "", a.ID); err != nil {
		t.Fatal("historical attachment unreadable", err)
	}
	if _, err = r.ManageTrash(ctx, user.ID, v.ID, "purge", "asset", a.ID); err != errPinned {
		t.Fatal("referenced asset purge", err)
	}
	if _, err = r.WriteFile(ctx, user.ID, v.ID, note.FileID, "delete_file", "", FileWrite{BaseVersion: updated.Version}); err != nil {
		t.Fatal(err)
	}
	if _, err = r.ManageTrash(ctx, "someone_else", v.ID, "empty", "", ""); err == nil {
		t.Fatal("cross-account purge")
	}
	if err = r.RunCleanup(ctx); err != nil {
		t.Fatal(err)
	}
	items, err := r.TrashItems(ctx, v.ID)
	if err != nil || len(items) != 2 || items[0].Expires-items[0].Deleted != 30*86400 {
		t.Fatal(items, err)
	}
	if _, err = db.Exec(`UPDATE trash_items SET deleted=unixepoch()-86400*31`); err != nil {
		t.Fatal(err)
	}
	if err = r.RunCleanup(ctx); err != nil {
		t.Fatal(err)
	}
	items, err = r.TrashItems(ctx, v.ID)
	if err != nil || len(items) != 0 {
		t.Fatal(items, err)
	}
	if _, err = os.Stat(newPath); !os.IsNotExist(err) {
		t.Fatal("unreferenced asset still on disk", err)
	}
	var n int
	if err = db.QueryRow(`SELECT count(*) FROM blobs`).Scan(&n); err != nil || n != 0 {
		t.Fatal("unreclaimed blobs", n, err)
	}
}

func TestRemotePurgeRetriesAfterRestart(t *testing.T) {
	for _, kind := range []string{"webdav", "s3"} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			root := t.TempDir()
			db, err := sqlite.Open(ctx, filepath.Join(root, "db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			if err = db.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			local, _ := blob.NewLocalStore(filepath.Join(root, "online"))
			repo := NewRepository(db, local)
			admin, err := repo.CreateUser(ctx, "admin@test.test", "hash")
			if err != nil {
				t.Fatal(err)
			}
			alice, _ := repo.CreateUser(ctx, "a@test.test", "hash")
			bob, _ := repo.CreateUser(ctx, "b@test.test", "hash")
			v, _ := repo.CreateVault(ctx, alice.ID, "A")
			other, _ := repo.CreateVault(ctx, bob.ID, "B")
			objects := map[string]string{}
			var reject atomic.Bool
			var mu sync.Mutex
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				key := strings.TrimPrefix(r.URL.Path, "/")
				if kind == "s3" {
					key = strings.TrimPrefix(key, "bucket/")
				}
				switch r.Method {
				case "MKCOL":
					w.WriteHeader(201)
				case "PUT":
					data, _ := io.ReadAll(r.Body)
					objects[key] = string(data)
				case "GET":
					if r.URL.Query().Get("list-type") == "2" {
						fmt.Fprint(w, `<ListBucketResult><IsTruncated>false</IsTruncated>`)
						for k := range objects {
							if strings.HasPrefix(k, r.URL.Query().Get("prefix")) {
								fmt.Fprintf(w, "<Contents><Key>%s</Key></Contents>", k)
							}
						}
						fmt.Fprint(w, `</ListBucketResult>`)
						return
					}
					data, ok := objects[key]
					if !ok {
						w.WriteHeader(404)
						return
					}
					io.WriteString(w, data)
				case "DELETE":
					if reject.Load() {
						w.WriteHeader(403)
						return
					}
					delete(objects, key)
					if kind == "webdav" {
						for k := range objects {
							if strings.HasPrefix(k, strings.TrimRight(key, "/")+"/") {
								delete(objects, k)
							}
						}
					}
					w.WriteHeader(204)
				default:
					w.WriteHeader(405)
				}
			}))
			defer srv.Close()
			profile := StorageConfig{Kind: kind, Endpoint: srv.URL, Username: "u", Secret: "pass", Region: "us-east-1", Bucket: "bucket"}
			if err = repo.ConfigureStorage(ctx, admin.ID, "online", profile); err != nil {
				t.Fatal(err)
			}
			for _, pair := range [][2]string{{alice.ID, v.ID}, {bob.ID, other.ID}} {
				if _, err = repo.WriteFile(ctx, pair[0], pair[1], "", "create_file", "", FileWrite{Path: "note.md", Content: []byte("same")}); err != nil {
					t.Fatal(err)
				}
			}
			if err = repo.ChangeUserStatus(ctx, admin.ID, alice.ID, "purge", "", alice.Email); err != nil {
				t.Fatal(err)
			}
			reject.Store(true)
			if err = repo.RunCleanup(ctx); err == nil {
				t.Fatal("failed remote delete reported success")
			}
			users, err := repo.ListAdminUsers(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var status bool
			for _, u := range users {
				if u.ID == alice.ID {
					status = u.CleanupError != "" && u.PendingBytes == 4 && u.Status == "purging"
				}
			}
			if !status {
				t.Fatal("missing pending bytes and error")
			}
			fresh := NewRepository(db, local)
			fresh.SetSettingsKey(repo.settingsKey)
			if err = fresh.LoadOnlineStorage(ctx); err != nil {
				t.Fatal(err)
			}
			reject.Store(false)
			if err = fresh.RunCleanup(ctx); err != nil {
				t.Fatal(err)
			}
			mu.Lock()
			defer mu.Unlock()
			kept := false
			for k := range objects {
				if strings.HasPrefix(k, "users/"+alice.ID+"/") {
					t.Fatal("object remained", k)
				}
				if strings.HasPrefix(k, "users/"+bob.ID+"/") {
					kept = true
				}
			}
			if !kept {
				t.Fatal("other account lost its object")
			}
		})
	}
}

func TestUnreferencedPictureGracePeriod(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	db, err := sqlite.Open(ctx, filepath.Join(root, "db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err = db.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	local, err := blob.NewLocalStore(root)
	if err != nil {
		t.Fatal(err)
	}
	r := NewRepository(db, local)
	u, err := r.CreateUser(ctx, "orphan@local.test", "unused")
	if err != nil {
		t.Fatal(err)
	}
	v, err := r.CreateVault(ctx, u.ID, "notes")
	if err != nil {
		t.Fatal(err)
	}
	data := "\x89PNG\r\n\x1a\nfixture"
	a, err := r.CreateAsset(ctx, u.ID, v.ID, "sample.png", "image/png", fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(data))), "", int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = r.CompleteUploadSession(ctx, v.ID, a.Upload, strings.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	a, err = r.AssetForUser(ctx, u.ID, v.ID, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, a.StorageKey)
	note, err := r.WriteFile(ctx, u.ID, v.ID, "", "create_file", "", FileWrite{Path: "note.md", Content: []byte("![](" + a.URL + ")")})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = r.WriteFile(ctx, u.ID, v.ID, note.FileID, "delete_file", "", FileWrite{BaseVersion: note.Version}); err != nil {
		t.Fatal(err)
	}
	if err = r.RunCleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(file); err != nil {
		t.Fatalf("trashed note lost picture: %v", err)
	}
	if _, err = r.ManageTrash(ctx, u.ID, v.ID, "purge", "file", note.FileID); err != nil {
		t.Fatal(err)
	}
	if err = r.RunCleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(file); err != nil {
		t.Fatalf("no grace period: %v", err)
	}
	if _, err = db.Exec(`UPDATE image_lifetimes SET orphan_since=unixepoch()-7*86400 WHERE asset_id=? AND orphan_since IS NOT NULL`, a.ID); err != nil {
		t.Fatal(err)
	}
	if err = r.RunCleanup(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(file); !os.IsNotExist(err) {
		t.Fatalf("expired image still present: %v", err)
	}
}
