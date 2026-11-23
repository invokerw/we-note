package blob

import (
	"context"
	"io"
	"time"
)

type Store interface {
	PutAt(context.Context, string, string, int64, time.Time, io.Reader) (string, error)
	OpenContext(context.Context, string, string, string) (io.ReadCloser, error)
}
