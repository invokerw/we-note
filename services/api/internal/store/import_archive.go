package store

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
	"io"
	"path"
	"reflect"
	"strings"
)

const maxImportZip = 256 << 20
const maxImportBytes = 512 << 20
const maxImportEntries = 10000

type importArchive struct {
	exportSnapshot
	entries map[string]*zip.File
}

func importError(message string) error { return fileError(400, "INVALID_IMPORT", message) }
func pathKey(p string) string          { return cases.Fold().String(norm.NFC.String(p)) }
func readEntry(f *zip.File, limit int64) ([]byte, error) {
	if f == nil {
		return nil, importError("缺少包内文件")
	}
	if f.UncompressedSize64 > uint64(limit) {
		return nil, importError("文件过大：" + f.Name)
	}
	body, err := f.Open()
	if err != nil {
		return nil, err
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, int64(f.UncompressedSize64)+1))
	if err != nil || uint64(len(data)) != f.UncompressedSize64 {
		return nil, importError("损坏的文件：" + f.Name)
	}
	return data, nil
}
func inspectArchive(input io.ReaderAt, size int64) (*importArchive, error) {
	z, err := zip.NewReader(input, size)
	if err != nil || len(z.File) > maxImportEntries {
		return nil, importError("请选择有效的 WeNote 离线便携 ZIP（最多 10000 个条目）")
	}
	a := &importArchive{entries: map[string]*zip.File{}}
	var total uint64
	for _, f := range z.File {
		if !PortablePath(f.Name) || !f.Mode().IsRegular() || a.entries[f.Name] != nil || f.UncompressedSize64 > maxImportZip || f.UncompressedSize64 > maxImportBytes-total {
			return nil, importError("条目重复、路径无效或解压大小超限：" + f.Name)
		}
		total += f.UncompressedSize64
		a.entries[f.Name] = f
	}
	raw, err := readEntry(a.entries["manifest.json"], 8<<20)
	if err != nil || json.Unmarshal(raw, &a.exportSnapshot) != nil || a.Mode != "portable" || a.Scope != "all" || a.Layout != "notes-assets" {
		return nil, importError("请选择 WeNote 的完整笔记库离线便携包")
	}
	raw, err = readEntry(a.entries["asset-manifest.json"], 8<<20)
	var assets []exportEntry
	if err != nil || json.Unmarshal(raw, &assets) != nil || !reflect.DeepEqual(assets, a.exportSnapshot.Assets) {
		return nil, importError("资源清单缺失或不一致")
	}
	raw, err = readEntry(a.entries["checksums.sha256"], 8<<20)
	if err != nil {
		return nil, err
	}
	hashes := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(string(raw), "\n"), "\n") {
		hash, name, ok := strings.Cut(line, "  ")
		if !ok || hashes[name] != "" || name == "checksums.sha256" || a.entries[name] == nil {
			return nil, importError("校验清单无效：" + name)
		}
		hashes[name] = "sha256:" + hash
	}
	expected := map[string]bool{"manifest.json": true, "asset-manifest.json": true, "checksums.sha256": true}
	notes := map[string]bool{}
	dirs := map[string]bool{}
	for _, batch := range []struct {
		items  []exportEntry
		prefix string
	}{{a.Files, "notes/"}, {a.Assets, "assets/"}} {
		for _, item := range batch.items {
			f := a.entries[item.Path]
			if !strings.HasPrefix(item.Path, batch.prefix) || f == nil || int64(f.UncompressedSize64) != item.Size || hashes[item.Path] != item.Hash {
				return nil, importError("清单与文件不符：" + item.Path)
			}
			expected[item.Path] = true
			if batch.prefix == "notes/" {
				key := pathKey(item.Path)
				if notes[key] || dirs[key] || item.Size > maxNoteBytes {
					return nil, importError("笔记冲突或过大：" + item.Path)
				}
				notes[key] = true
				for dir := path.Dir(key); dir != "."; dir = path.Dir(dir) {
					if notes[dir] {
						return nil, importError("笔记与目录同名：" + dir)
					}
					dirs[dir] = true
				}
			}
		}
	}
	for _, f := range z.File {
		if !expected[f.Name] {
			return nil, importError("文件未列入清单：" + f.Name)
		}
		if f.Name == "checksums.sha256" {
			continue
		}
		body, e := f.Open()
		if e != nil {
			return nil, e
		}
		h := sha256.New()
		n, e := io.Copy(h, io.LimitReader(body, int64(f.UncompressedSize64)+1))
		body.Close()
		if e != nil || uint64(n) != f.UncompressedSize64 || hashes[f.Name] != fmt.Sprintf("sha256:%x", h.Sum(nil)) {
			return nil, importError("校验失败：" + f.Name)
		}
	}
	return a, nil
}
