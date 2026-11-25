package store

import "context"

func (r *Repository) Avatar(ctx context.Context, user string) (string, error) {
	var avatar string
	err := r.db.QueryRowContext(ctx, `SELECT COALESCE((SELECT avatar FROM user_avatars WHERE user_id=?),'')`, user).Scan(&avatar)
	return avatar, err
}

func (r *Repository) SetAvatar(ctx context.Context, user, avatar string) error {
	if avatar == "" {
		_, err := r.db.ExecContext(ctx, `DELETE FROM user_avatars WHERE user_id=?`, user)
		return err
	}
	_, err := r.db.ExecContext(ctx, `INSERT INTO user_avatars(user_id,avatar) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET avatar=excluded.avatar`, user, avatar)
	return err
}
