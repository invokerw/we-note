package store

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const maxPluginSettingsSize = 64 << 10

func (r *Repository) PluginSettings(ctx context.Context, userID string) (map[string]json.RawMessage, error) {
	rows, err := r.db.QueryContext(ctx, `
		SELECT plugin_id, settings_json
		FROM user_plugin_settings
		WHERE user_id = ?
		ORDER BY plugin_id`, userID)
	if err != nil {
		return nil, fmt.Errorf("load plugin settings: %w", err)
	}
	defer rows.Close()
	settings := map[string]json.RawMessage{}
	for rows.Next() {
		var pluginID, raw string
		if err := rows.Scan(&pluginID, &raw); err != nil {
			return nil, fmt.Errorf("scan plugin settings: %w", err)
		}
		settings[pluginID] = json.RawMessage(raw)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate plugin settings: %w", err)
	}
	return settings, nil
}

func (r *Repository) SetPluginSettings(
	ctx context.Context,
	userID string,
	pluginID string,
	settings json.RawMessage,
) error {
	pluginID = strings.TrimSpace(pluginID)
	if pluginID == "" || len(pluginID) > 128 {
		return fmt.Errorf("plugin id is invalid")
	}
	if len(settings) == 0 || len(settings) > maxPluginSettingsSize || !json.Valid(settings) {
		return fmt.Errorf("plugin settings are invalid")
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(settings, &object); err != nil || object == nil {
		return fmt.Errorf("plugin settings must be a JSON object")
	}
	_, err := r.db.ExecContext(ctx, `
		INSERT INTO user_plugin_settings(user_id, plugin_id, settings_json, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, plugin_id) DO UPDATE SET
		settings_json = excluded.settings_json,
		updated_at = excluded.updated_at`,
		userID,
		pluginID,
		string(settings),
		formatTime(time.Now().UTC()),
	)
	if err != nil {
		return fmt.Errorf("save plugin settings: %w", err)
	}
	return nil
}
