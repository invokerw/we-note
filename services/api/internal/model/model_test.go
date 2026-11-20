package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestChangeRequestUsesProtocolFieldNames(t *testing.T) {
	payload, err := json.Marshal(ChangeRequest{
		Mode:        "submit",
		VaultID:     "vault_1",
		OperationID: "op_1",
		FileID:      "file_1",
		ContentHash: "sha256:abc",
		Metadata:    Metadata{Format: "md"},
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}
	got := string(payload)
	for _, field := range []string{`"operation_id"`, `"vault_id"`, `"content_hash"`, `"metadata"`} {
		if !strings.Contains(got, field) {
			t.Fatalf("JSON missing %s: %s", field, got)
		}
	}
}
