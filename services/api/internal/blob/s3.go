package blob

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

type S3Store struct {
	client         *s3.Client
	bucket, prefix string
}

func NewS3Store(ctx context.Context, bucket, prefix, endpoint, region string) (*S3Store, error) {
	if bucket == "" || region == "" {
		return nil, errors.New("S3 bucket and region required")
	}
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region))
	if err != nil {
		return nil, err
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		if endpoint != "" {
			o.BaseEndpoint = aws.String(endpoint)
			o.UsePathStyle = true
		}
	})
	return &S3Store{client, bucket, strings.Trim(prefix, "/")}, nil
}
func (s *S3Store) key(vault, hash string) (string, error) {
	if !vaultIDPattern.MatchString(vault) || !hashPattern.MatchString(hash) {
		return "", errors.New("invalid blob identity")
	}
	digest := strings.TrimPrefix(hash, "sha256:")
	return path.Join(s.prefix, "blobs", vault, digest[:2], digest), nil
}
func (s *S3Store) Put(ctx context.Context, vault, hash string, size int64, source io.Reader) (string, error) {
	key, err := s.key(vault, hash)
	if err != nil {
		return "", err
	}
	if size < 0 {
		return "", errors.New("invalid size")
	}
	temp, err := os.CreateTemp("", "wenote-s3-*")
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
		return "", errors.New("S3 upload content mismatch")
	}
	if _, err = temp.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	_, err = s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: &s.bucket, Key: &key, Body: temp, ContentLength: &size, ChecksumSHA256: aws.String(base64.StdEncoding.EncodeToString(sum))})
	if err != nil {
		return "", fmt.Errorf("put S3 blob: %w", err)
	}
	return key, nil
}
func (s *S3Store) OpenContext(ctx context.Context, vault, hash string) (io.ReadCloser, error) {
	key, err := s.key(vault, hash)
	if err != nil {
		return nil, err
	}
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		return nil, err
	}
	return out.Body, nil
}
