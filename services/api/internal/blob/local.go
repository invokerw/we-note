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
	storageKey, err := objectKey(vaultID, contentHash)
	if err != nil {
		return "", err
	}
	if contentSize < 0 {
		return "", errors.New("content size cannot be negative")
	}
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
	key, err := objectKey(vaultID, contentHash)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(s.root, key)
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open blob: %w", err)
	}
	return file, nil
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
