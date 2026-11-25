package blob

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
)

var documentPath = regexp.MustCompile(`^(manifest\.json|migration-report\.json|notes/[A-Za-z0-9_-]+/(current|versions/[A-Za-z0-9_-]+)\.(md|txt|json|xmind))$`)

func WriteDocument(ctx context.Context, storage Store, owner, vault, relative string, data []byte) error {
	return WriteDocumentFrom(ctx, storage, owner, vault, relative, bytes.NewReader(data), int64(len(data)), fmt.Sprintf("sha256:%x", sha256.Sum256(data)))
}
func WriteDocumentFrom(ctx context.Context, storage Store, owner, vault, relative string, src io.Reader, size int64, hash string) error {
	ns, err := VaultNamespace(owner, vault)
	if err != nil {
		return err
	}
	if !documentPath.MatchString(relative) {
		return errors.New("invalid note document path")
	}
	key := ns + "/" + relative
	dir := ""
	local, isLocal := storage.(*LocalStore)
	if isLocal {
		dir = filepath.Dir(filepath.Join(local.root, filepath.FromSlash(key)))
		if err = os.MkdirAll(dir, 0750); err != nil {
			return err
		}
	}
	f, err := os.CreateTemp(dir, ".wenote-note-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	digest := sha256.New()
	written, err := copyWithContext(ctx, io.MultiWriter(f, digest), io.LimitReader(src, size+1))
	if err != nil {
		return err
	}
	sum := digest.Sum(nil)
	if written != size || fmt.Sprintf("sha256:%x", sum) != hash {
		return errors.New("note object integrity check failed")
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if isLocal {
		if err = f.Close(); err != nil {
			return err
		}
		return os.Rename(f.Name(), filepath.Join(local.root, filepath.FromSlash(key)))
	}
	dest, ok := storage.(Objects)
	if !ok {
		return errors.New("storage cannot publish note files")
	}
	if _, err = f.Seek(0, 0); err != nil {
		return err
	}
	if err = dest.PutFile(ctx, key, f, size, sum); err != nil {
		return err
	}
	reader, err := dest.GetFile(ctx, key)
	if err != nil {
		return err
	}
	defer reader.Close()
	verify := sha256.New()
	n, err := io.Copy(verify, io.LimitReader(reader, size+1))
	if err != nil {
		return err
	}
	if n != size || !bytes.Equal(verify.Sum(nil), sum[:]) {
		return errors.New("published note verification failed")
	}
	return nil
}
func RemoveDocument(ctx context.Context, storage Store, owner, vault, relative string) error {
	ns, err := VaultNamespace(owner, vault)
	if err != nil {
		return err
	}
	if !documentPath.MatchString(relative) {
		return errors.New("invalid note document path")
	}
	return removeKey(ctx, storage, ns+"/"+relative, false)
}
