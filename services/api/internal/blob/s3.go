package blob

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/feature/s3/transfermanager"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
)

type S3Store struct {
	client         *s3.Client
	bucket, prefix string
}

func NewS3Store(ctx context.Context, bucket, prefix, endpoint, region string) (*S3Store, error) {
	return NewS3WithCredentials(ctx, bucket, prefix, endpoint, region, "", "")
}
func NewS3WithCredentials(ctx context.Context, bucket, prefix, endpoint, region, username, secret string) (*S3Store, error) {
	if bucket == "" || region == "" {
		return nil, errors.New("S3 bucket and region required")
	}
	opts := []func(*config.LoadOptions) error{config.WithRegion(region)}
	if username != "" {
		opts = append(opts, config.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(username, secret, "")))
	}
	cfg, err := config.LoadDefaultConfig(ctx, opts...)
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

func (s *S3Store) keyAt(vault, hash string, createdAt time.Time) (string, error) {
	key, err := objectKeyAt(vault, hash, createdAt)
	if err != nil {
		return "", err
	}
	return path.Join(s.prefix, key), nil
}
func (s *S3Store) PutAt(ctx context.Context, vault, hash string, size int64, createdAt time.Time, in io.Reader) (string, error) {
	return (RemoteStore{s}).PutAt(ctx, vault, hash, size, createdAt, in)
}
func (s *S3Store) OpenContext(ctx context.Context, vault, hash, key string) (io.ReadCloser, error) {
	// Earlier releases persisted the bucket prefix along with the object name.
	if s.prefix != "" && strings.HasPrefix(key, s.prefix+"/") {
		if _, err := validateObjectKey(vault, hash, key); err != nil {
			key = strings.TrimPrefix(key, s.prefix+"/")
		}
	}
	return (RemoteStore{s}).OpenContext(ctx, vault, hash, key)
}
func (s *S3Store) PutFile(ctx context.Context, name string, f *os.File, size int64, sum []byte) error {
	key := path.Join(s.prefix, name)
	if size >= 64<<20 {
		_, err := transfermanager.New(s.client).UploadObject(ctx, &transfermanager.UploadObjectInput{Bucket: &s.bucket, Key: &key, Body: f, ContentLength: &size})
		return err
	}
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{Bucket: &s.bucket, Key: &key, Body: f, ContentLength: &size, ChecksumSHA256: aws.String(base64.StdEncoding.EncodeToString(sum))})
	if err != nil {
		return fmt.Errorf("put S3 object: %w", err)
	}
	return nil
}
func (s *S3Store) GetFile(ctx context.Context, name string) (io.ReadCloser, error) {
	key := path.Join(s.prefix, name)
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		return nil, s3ReadError(err)
	}
	return out.Body, nil
}

func s3ReadError(err error) error {
	var response *smithyhttp.ResponseError
	if errors.As(err, &response) && response.HTTPStatusCode() == 404 {
		return os.ErrNotExist
	}
	var api smithy.APIError
	if errors.As(err, &api) && (api.ErrorCode() == "NoSuchKey" || api.ErrorCode() == "NotFound") {
		return os.ErrNotExist
	}
	return err
}
