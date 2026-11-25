package store

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"path"
	"strings"
)

// Archive checksums describe the bytes a reader extracts. The frozen version ID
// and source hash still identify the original note after a portable rewrite.
func (r *Repository) writeExportSnapshot(ctx context.Context, z *zip.Writer, vault string, snap *exportSnapshot) error {
	// Jobs queued before portable exports used online links.
	if snap.Mode == "" {
		snap.Mode = "online"
	}
	snap.Layout = "notes-assets"
	var checksums strings.Builder
	targets := map[string]string{}
	if snap.Mode == "portable" {
		for _, a := range snap.Assets {
			targets[a.URL] = a.Path
			if i := strings.Index(a.URL, "/assets/"); i >= 0 {
				p := strings.Split(a.URL[i+len("/assets/"):], "/")
				if len(p) == 6 {
					p[5] = strings.TrimPrefix(a.Hash, "sha256:")
					targets[a.URL[:i]+"/assets/"+strings.Join(p, "/")] = a.Path
					targets[a.URL[:i]+"/assets/"+strings.Join(p[2:], "/")] = a.Path
				}
			}
			targets[r.publicBase+"/assets/"+a.ID] = a.Path
		}
	}
	for i := range snap.Files {
		f := &snap.Files[i]
		if len(targets) > 0 && strings.EqualFold(path.Ext(f.Path), ".md") {
			data, err := r.readNoteBlob(ctx, vault, f.Hash, f.Size)
			if err != nil {
				return err
			}
			w, err := z.Create(f.Path)
			if err != nil {
				return err
			}
			h := sha256.New()
			f.Size, err = writePortableMarkdown(io.MultiWriter(w, h), data, f.Path, targets)
			if err != nil {
				return err
			}
			hash := fmt.Sprintf("sha256:%x", h.Sum(nil))
			if hash != f.Hash {
				f.SourceHash, f.Hash = f.Hash, hash
			}
		} else if err := r.writeExportEntry(ctx, z, vault, *f); err != nil {
			return err
		}
		fmt.Fprintf(&checksums, "%s  %s\n", strings.TrimPrefix(f.Hash, "sha256:"), f.Path)
	}
	written := map[string]bool{}
	for _, a := range snap.Assets {
		if written[a.Path] {
			continue
		}
		written[a.Path] = true
		if err := r.writeExportEntry(ctx, z, vault, a); err != nil {
			return err
		}
		fmt.Fprintf(&checksums, "%s  %s\n", strings.TrimPrefix(a.Hash, "sha256:"), a.Path)
	}
	writeManifest := func(name string, value any) error {
		w, err := z.Create(name)
		if err != nil {
			return err
		}
		h := sha256.New()
		if err = json.NewEncoder(io.MultiWriter(w, h)).Encode(value); err != nil {
			return err
		}
		fmt.Fprintf(&checksums, "%x  %s\n", h.Sum(nil), name)
		return nil
	}
	if err := writeManifest("manifest.json", snap); err != nil {
		return err
	}
	if snap.Scope != "notes" {
		if err := writeManifest("asset-manifest.json", snap.Assets); err != nil {
			return err
		}
	}
	w, err := z.Create("checksums.sha256")
	if err != nil {
		return err
	}
	_, err = io.WriteString(w, checksums.String())
	return err
}
