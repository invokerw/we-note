package store

import (
	"context"
	"database/sql"
)

// A vault uses the same calendar on every client and on the cleanup worker.
const historyToday = `date('now','+8 hours')`

// scope is either one vault or a single file in it. Date arithmetic uses whole
// seconds to avoid SQLite rounding fractional timestamps across midnight.
func rankedHistory(scope string) string {
	return `WITH entries AS (
 SELECT v.id, v.file_id, v.vault_revision, v.id=f.current_version_id AS current,
 date(substr(v.created_at,1,19),'+8 hours') AS day
 FROM file_versions v JOIN files f ON f.id=v.file_id WHERE ` + scope + `
 ), ranked AS (
 SELECT *,row_number() OVER (PARTITION BY file_id,current ORDER BY vault_revision DESC) AS recent,
 row_number() OVER (PARTITION BY file_id,day ORDER BY vault_revision DESC) AS daily FROM entries
 ) `
}

const keepHistory = `(current OR recent<=10 OR (daily=1 AND day BETWEEN date(` + historyToday + `,'-29 days') AND ` + historyToday + `))`

func visibleHistory() string {
	return ` AND v.id IN (` + rankedHistory(`v.vault_id=?1 AND v.file_id=?2`) + `SELECT id FROM ranked WHERE ` + keepHistory + `)`
}

// Keep a small receipt when the sync log loses a referenced version. Replays
// still use their original operation ledger, and cross-API key reuse is rejected.
const changeReceipts = `(SELECT vault_id,operation_id,id,file_id,version_id,vault_revision FROM changes UNION ALL SELECT vault_id,operation_id,id,file_id,version_id,vault_revision FROM history_change_receipts)`

func pruneNoteHistory(ctx context.Context, tx *sql.Tx, vault string) (bool, error) {
	ids, err := stringList(ctx, tx, rankedHistory(`v.vault_id=?1`)+`SELECT id FROM ranked h WHERE NOT `+keepHistory+`
 AND NOT EXISTS(SELECT 1 FROM (`+snapshots+`) WHERE vault=?1 AND instr(snapshot,h.id)>0)
 AND NOT EXISTS(SELECT 1 FROM share_copy_versions WHERE source_version=h.id OR target_version=h.id)`, vault)
	if err != nil {
		return false, err
	}
	for _, id := range ids {
		var hash string
		if err = tx.QueryRowContext(ctx, `SELECT content_hash FROM file_versions WHERE id=?`, id).Scan(&hash); err != nil {
			return false, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE vaults SET min_available_revision=max(min_available_revision,(SELECT coalesce(max(vault_revision),0) FROM changes WHERE version_id=?)) WHERE id=?`, id, vault); err != nil {
			return false, err
		}
		for _, q := range []string{
			`INSERT INTO history_change_receipts SELECT vault_id,operation_id,id,file_id,version_id,vault_revision FROM changes WHERE version_id=?`,
			`DELETE FROM changes WHERE version_id=?`,
			`UPDATE file_versions SET parent_version_id=NULL WHERE parent_version_id=?`,
			`DELETE FROM file_versions WHERE id=?`,
		} {
			if _, err = tx.ExecContext(ctx, q, id); err != nil {
				return false, err
			}
		}
		if err = queueUnused(ctx, tx, vault, hash); err != nil {
			return false, err
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT OR REPLACE INTO history_sweeps(vault,day) VALUES(?,`+historyToday+`)`, vault)
	return len(ids) > 0, err
}
