package blob

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"
	"time"
)

// Objects stores named archive files and the immutable objects used by online storage.
type Objects interface {
	PutFile(context.Context, string, *os.File, int64, []byte) error
	GetFile(context.Context, string) (io.ReadCloser, error)
}

type RemoteStore struct{ Objects }

func objectKey(vault, hash string) (string, error) {
	prefix, err := vaultPrefix(vault)
	if err != nil || !hashPattern.MatchString(hash) {
		return "", errors.New("invalid blob identity")
	}
	digest := strings.TrimPrefix(hash, "sha256:")
	return path.Join(prefix, digest[:2], digest), nil
}
func (s RemoteStore) OpenContext(ctx context.Context, vault, hash string) (io.ReadCloser, error) {
	key, err := objectKey(vault, hash)
	if err != nil {
		return nil, err
	}
	return s.GetFile(ctx, key)
}
func (s RemoteStore) Put(ctx context.Context, vault, hash string, size int64, source io.Reader) (string, error) {
	key, err := objectKey(vault, hash)
	if err != nil {
		return "", err
	}
	temp, err := os.CreateTemp("", "wenote-object-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(temp.Name())
	defer temp.Close()
	digest := sha256.New()
	n, err := copyWithContext(ctx, io.MultiWriter(temp, digest), source)
	if err != nil {
		return "", err
	}
	sum := digest.Sum(nil)
	if n != size || "sha256:"+hex.EncodeToString(sum) != hash {
		return "", errors.New("对象大小或 SHA-256 不匹配")
	}
	if _, err = temp.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return key, s.PutFile(ctx, key, temp, size, sum)
}

type WebDAV struct {
	Base               *url.URL
	Username, Password string
}

var davClient = &http.Client{Timeout: 30 * time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func (s WebDAV) request(ctx context.Context, method, key string, body io.Reader, size int64) (*http.Response, error) {
	dest := s.Base.JoinPath(key)
	req, err := http.NewRequestWithContext(ctx, method, dest.String(), body)
	if err != nil {
		return nil, err
	}
	req.ContentLength = size
	if s.Username != "" {
		req.SetBasicAuth(s.Username, s.Password)
	}
	return davClient.Do(req)
}
func (s WebDAV) PutFile(ctx context.Context, key string, file *os.File, size int64, _ []byte) error {
	parts := strings.Split(key, "/")
	for i := 1; i < len(parts); i++ {
		resp, err := s.request(ctx, "MKCOL", strings.Join(parts[:i], "/"), nil, 0)
		if err != nil {
			return err
		}
		resp.Body.Close()
		if resp.StatusCode != 405 && (resp.StatusCode < 200 || resp.StatusCode >= 300) {
			return fmt.Errorf("WebDAV 创建目录失败（HTTP %d）", resp.StatusCode)
		}
	}
	resp, err := s.request(ctx, "PUT", key, io.NewSectionReader(file, 0, size), size)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("WebDAV 写入失败（HTTP %d）", resp.StatusCode)
	}
	return nil
}
func (s WebDAV) GetFile(ctx context.Context, key string) (io.ReadCloser, error) {
	resp, err := s.request(ctx, "GET", key, nil, 0)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		if resp.StatusCode == 404 {
			return nil, os.ErrNotExist
		}
		return nil, fmt.Errorf("WebDAV 读取失败（HTTP %d）", resp.StatusCode)
	}
	return resp.Body, nil
}
