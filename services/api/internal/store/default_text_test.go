package store

import "testing"

func TestDefaultTextFormat(t *testing.T) {
	for _, p := range []string{"目录/table.CSV", "logs/demo.log", "README"} {
		if got, err := fileFormat(p); err != nil || got != "txt" {
			t.Errorf("fileFormat(%q) = %q, %v", p, got, err)
		}
	}
}
