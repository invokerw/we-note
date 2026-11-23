package blob

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var hashPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
var vaultIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

type LocalStore struct {
	root string
}

func NewLocalStore(root string) (*LocalStore, error) {
	if root == "" {
		return nil, errors.New("blob root is required")
	}
	if err := os.MkdirAll(root, 0o750); err != nil {
		return nil, fmt.Errorf("create blob root: %w", err)
	}
	return &LocalStore{root: root}, nil
}

func (s *LocalStore) Put(ctx context.Context, vaultID, contentHash string, contentSize int64, source io.Reader) (string, error) {
	return s.PutAt(ctx, vaultID, contentHash, contentSize, time.Now().UTC(), source)
}

func (s *LocalStore) PutAt(ctx context.Context, vaultID, contentHash string, contentSize int64, createdAt time.Time, source io.Reader) (string, error) {
	if !vaultIDPattern.MatchString(vaultID) {
		return "", fmt.Errorf("invalid vault id %q", vaultID)
	}
	if !hashPattern.MatchString(contentHash) {
		return "", fmt.Errorf("invalid content hash %q", contentHash)
	}
	if contentSize < 0 {
		return "", errors.New("content size cannot be negative")
	}

	hexHash := contentHash[len("sha256:"):]
	storageKey := filepath.Join("blobs", vaultID, createdAt.UTC().Format("2006/01/02"), hexHash)
	target := filepath.Join(s.root, storageKey)
	if err := os.MkdirAll(filepath.Dir(target), 0o750); err != nil {
		return "", fmt.Errorf("create blob directory: %w", err)
	}

	temporary, err := os.CreateTemp(filepath.Dir(target), ".upload-*")
	if err != nil {
		return "", fmt.Errorf("create temporary blob: %w", err)
	}
	temporaryName := temporary.Name()
	defer os.Remove(temporaryName)

	hasher := sha256.New()
	written, err := copyWithContext(ctx, io.MultiWriter(temporary, hasher), source)
	if err != nil {
		temporary.Close()
		return "", fmt.Errorf("write blob: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return "", fmt.Errorf("close temporary blob: %w", err)
	}
	if written != contentSize {
		return "", fmt.Errorf("content size mismatch: got %d, want %d", written, contentSize)
	}
	actualHash := "sha256:" + hex.EncodeToString(hasher.Sum(nil))
	if actualHash != contentHash {
		return "", fmt.Errorf("content hash mismatch: got %s, want %s", actualHash, contentHash)
	}

	if existingInfo, err := os.Stat(target); err == nil {
		if existingInfo.Size() != contentSize {
			return "", fmt.Errorf("existing blob size mismatch: got %d, want %d", existingInfo.Size(), contentSize)
		}
		return storageKey, nil
	} else if !os.IsNotExist(err) {
		return "", fmt.Errorf("inspect existing blob: %w", err)
	}

	if err := os.Rename(temporaryName, target); err != nil {
		if errors.Is(err, os.ErrExist) {
			return storageKey, nil
		}
		return "", fmt.Errorf("commit blob: %w", err)
	}
	return storageKey, nil
}

func (s *LocalStore) Open(vaultID, contentHash string) (io.ReadCloser, error) {
	return s.OpenContext(context.Background(), vaultID, contentHash, "")
}

func (s *LocalStore) OpenContext(ctx context.Context, vaultID, contentHash, storageKey string) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !vaultIDPattern.MatchString(vaultID) || !hashPattern.MatchString(contentHash) {
		return nil, errors.New("invalid blob identity")
	}
	hexHash := contentHash[len("sha256:"):]
	var path string
	if storageKey != "" {
		var err error
		path, err = s.pathForOpen(vaultID, hexHash, storageKey)
		if err != nil {
			return nil, err
		}
	}
	if storageKey == "" {
		legacyPath := filepath.Join(s.root, "blobs", vaultID, hexHash[:2], hexHash)
		file, err := os.Open(legacyPath)
		if err == nil {
			return file, nil
		}
		matches, globErr := filepath.Glob(filepath.Join(s.root, "blobs", vaultID, "*", "*", "*", hexHash))
		if globErr == nil && len(matches) > 0 {
			path = matches[0]
		} else {
			path = legacyPath
		}
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open blob: %w", err)
	}
	return file, nil
}

func (s *LocalStore) pathForOpen(vaultID, hexHash, storageKey string) (string, error) {
	clean := filepath.Clean(filepath.FromSlash(storageKey))
	prefix := filepath.Join("blobs", vaultID) + string(filepath.Separator)
	if filepath.IsAbs(clean) || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) || !strings.HasPrefix(clean, prefix) || filepath.Base(clean) != hexHash {
		return "", errors.New("invalid blob storage key")
	}
	return filepath.Join(s.root, clean), nil
}

func copyWithContext(ctx context.Context, destination io.Writer, source io.Reader) (int64, error) {
	buffer := make([]byte, 32*1024)
	var written int64
	for {
		select {
		case <-ctx.Done():
			return written, ctx.Err()
		default:
		}

		read, err := source.Read(buffer)
		if read > 0 {
			count, writeErr := destination.Write(buffer[:read])
			written += int64(count)
			if writeErr != nil {
				return written, writeErr
			}
			if count != read {
				return written, io.ErrShortWrite
			}
		}
		if err != nil {
			if err == io.EOF {
				return written, nil
			}
			return written, err
		}
	}
}
