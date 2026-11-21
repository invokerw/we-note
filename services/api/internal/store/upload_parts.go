package store

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"hash"
	"io"
	"time"
)

const PartSize = 1 << 20
const MaxAssetSize = 256 << 20

// Staging one part per row keeps retries durable and bounds assembly memory for both blob stores.
func (r *Repository) AssetParts(ctx context.Context, a Asset) ([]int, error) {
	rows, err := r.db.QueryContext(ctx, `SELECT number FROM upload_parts JOIN upload_part_leases USING(upload_id) WHERE upload_id=? AND expires>? ORDER BY number`, a.Upload, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	parts := []int{}
	for rows.Next() {
		var n int
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		parts = append(parts, n)
	}
	return parts, rows.Err()
}

func (r *Repository) PutAssetPart(ctx context.Context, a Asset, number int, contentRange, hash string, body io.Reader) error {
	count := (a.Size + PartSize - 1) / PartSize
	if number < 0 || int64(number) >= count {
		return fileError(400, "INVALID_PART", "part number outside asset")
	}
	start := int64(number) * PartSize
	size := min(int64(PartSize), a.Size-start)
	if contentRange != fmt.Sprintf("bytes %d-%d/%d", start, start+size-1, a.Size) || !syncHashPattern.MatchString(hash) {
		return fileError(400, "INVALID_PART", "expected exact Content-Range and X-Part-Hash")
	}
	data, err := io.ReadAll(io.LimitReader(body, size+1))
	if err != nil {
		return err
	}
	if int64(len(data)) != size || fmt.Sprintf("sha256:%x", sha256.Sum256(data)) != hash {
		return fileError(400, "INVALID_PART", "part size or hash mismatch")
	}
	tx, err := r.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now()
	if _, err = tx.ExecContext(ctx, `DELETE FROM upload_part_leases WHERE expires<=?`, now.Unix()); err != nil {
		return err
	}
	// The status check and insert must serialize with completion and its staging cleanup.
	var status string
	if err = tx.QueryRowContext(ctx, `SELECT status FROM upload_sessions WHERE id=?`, a.Upload).Scan(&status); err != nil {
		return err
	}
	if status != "pending" {
		return fileError(409, "UPLOAD_CLOSED", "upload already closed")
	}
	var old string
	err = tx.QueryRowContext(ctx, `SELECT hash FROM upload_parts WHERE upload_id=? AND number=?`, a.Upload, number).Scan(&old)
	if err == nil && old != hash {
		return fileError(409, "PART_CONFLICT", "part already has different bytes")
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO upload_part_leases(upload_id,expires) VALUES(?,?) ON CONFLICT(upload_id) DO UPDATE SET expires=excluded.expires`, a.Upload, now.Add(24*time.Hour).Unix()); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO upload_parts(upload_id,number,hash,data) VALUES(?,?,?,?)`, a.Upload, number, hash, data); err != nil {
		return err
	}
	return tx.Commit()
}

type stagedReader struct {
	ctx           context.Context
	db            *sql.DB
	upload        string
	number, count int
	current       *bytes.Reader
	digest        hash.Hash
	want          string
}

func (s *stagedReader) Read(p []byte) (int, error) {
	if s.current == nil || s.current.Len() == 0 {
		if s.number == s.count {
			if fmt.Sprintf("sha256:%x", s.digest.Sum(nil)) != s.want {
				return 0, fileError(409, "CONTENT_HASH_MISMATCH", "assembled content hash mismatch")
			}
			return 0, io.EOF
		}
		var data []byte
		if err := s.db.QueryRowContext(s.ctx, `SELECT data FROM upload_parts JOIN upload_part_leases USING(upload_id) WHERE upload_id=? AND number=? AND expires>?`, s.upload, s.number, time.Now().Unix()).Scan(&data); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return 0, fileError(409, "MISSING_PART", "upload missing parts before assembly")
			}
			return 0, err
		}
		s.digest.Write(data)
		s.number++
		s.current = bytes.NewReader(data)
	}
	return s.current.Read(p)
}
func (r *Repository) AssembleAsset(ctx context.Context, a Asset) error {
	reader := &stagedReader{ctx: ctx, db: r.db.DB, digest: sha256.New(), want: a.Hash, upload: a.Upload, count: int((a.Size + PartSize - 1) / PartSize)}
	_, err := r.CompleteUploadSession(ctx, a.Vault, a.Upload, reader)
	if err != nil { // A competing completion may already have removed staging rows.
		s, lookup := r.UploadSession(ctx, a.Vault, a.Upload)
		if lookup == nil && s.Status == "completed" {
			return nil
		}
		var specific *SyncError
		if errors.As(err, &specific) {
			return specific
		}
		return fmt.Errorf("assemble asset: %w", err)
	}
	return nil
}
