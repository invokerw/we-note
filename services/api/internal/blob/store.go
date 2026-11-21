package blob

import (
	"context"
	"io"
)

type Store interface {
	Put(context.Context, string, string, int64, io.Reader) (string, error)
	OpenContext(context.Context, string, string) (io.ReadCloser, error)
}

func (s *LocalStore) OpenContext(ctx context.Context, vaultID, hash string) (io.ReadCloser, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return s.Open(vaultID, hash)
}
