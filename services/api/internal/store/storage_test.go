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
	"testing"

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
			key, err := local.Put(ctx, "v", hash, size, strings.NewReader(text))
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
			if _, err = repo.SaveEncrypted(ctx, "owner", encryptedID, envelope); err != nil {
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
