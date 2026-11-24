package blob

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/aws/aws-sdk-go-v2/service/s3"
)

func VaultNamespace(owner, vault string) (string, error) {
	if !vaultIDPattern.MatchString(owner) || !vaultIDPattern.MatchString(vault) {
		return "", errors.New("invalid vault owner or id")
	}
	return path.Join("users", owner, "vaults", vault), nil
}
func vaultPrefix(vault string) (string, error) {
	if vaultIDPattern.MatchString(vault) {
		return path.Join("blobs", vault), nil
	}
	p := strings.Split(vault, "/")
	if len(p) == 4 && p[0] == "users" && p[2] == "vaults" {
		return VaultNamespace(p[1], p[3])
	}
	return "", errors.New("invalid vault namespace")
}

// Remove deletes a single content object, or the entire validated vault prefix for an account purge.
func Remove(ctx context.Context, s Store, vault, hash string) error {
	key, err := vaultPrefix(vault)
	if hash != "" {
		key, err = objectKey(vault, hash)
	}
	if err != nil {
		return err
	}
	return removeKey(ctx, s, key, hash == "")
}

// RemoveKey deletes one validated date- or hash-based object.
func RemoveKey(ctx context.Context, s Store, vault, hash, stored string) error {
	key, err := validateObjectKey(vault, hash, stored)
	if err != nil {
		return err
	}
	return removeKey(ctx, s, key, false)
}
func removeKey(ctx context.Context, s Store, key string, tree bool) error {
	switch target := s.(type) {
	case *LocalStore:
		file := filepath.Join(target.root, filepath.FromSlash(key))
		if tree {
			return os.RemoveAll(file)
		}
		err := os.Remove(file)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	case RemoteStore:
		return removeRemote(ctx, target.Objects, key, tree)
	case *S3Store:
		return removeRemote(ctx, target, key, tree)
	default:
		return errors.New("storage does not support cleanup")
	}
}
func removeRemote(ctx context.Context, objects Objects, key string, tree bool) error {
	switch target := objects.(type) {
	case WebDAV:
		if tree {
			key += "/"
		}
		res, err := target.request(ctx, "DELETE", key, nil, 0)
		if err != nil {
			return err
		}
		defer res.Body.Close()
		if res.StatusCode == 404 || res.StatusCode == 200 || res.StatusCode == 204 {
			return nil
		}
		return fmt.Errorf("WebDAV 删除失败（HTTP %d）", res.StatusCode)
	case *S3Store:
		key = path.Join(target.prefix, key)
		drop := func(name string) error {
			_, err := target.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: &target.bucket, Key: &name})
			return err
		}
		if !tree {
			return drop(key)
		}
		prefix := key + "/"
		pages := s3.NewListObjectsV2Paginator(target.client, &s3.ListObjectsV2Input{Bucket: &target.bucket, Prefix: &prefix})
		for pages.HasMorePages() {
			p, err := pages.NextPage(ctx)
			if err != nil {
				return err
			}
			for _, o := range p.Contents {
				if o.Key == nil || !strings.HasPrefix(*o.Key, prefix) {
					return errors.New("unexpected key in vault listing")
				}
				if err = drop(*o.Key); err != nil {
					return err
				}
			}
		}
		return nil
	default:
		return errors.New("remote storage does not support cleanup")
	}
}

func RemoveOwner(ctx context.Context, s Store, owner string) error {
	if !vaultIDPattern.MatchString(owner) {
		return errors.New("invalid owner")
	}
	key := path.Join("users", owner)
	switch target := s.(type) {
	case *LocalStore:
		return os.RemoveAll(filepath.Join(target.root, key))
	case *S3Store:
		return removeRemote(ctx, target, key, true)
	case RemoteStore:
		return removeRemote(ctx, target.Objects, key, true)
	default:
		return errors.New("unsupported storage")
	}
}
