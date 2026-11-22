package store

import (
	"bytes"
	"context"
	"encoding/json"
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
	"go.yaml.in/yaml/v3"
)

type Heading struct {
	Level int    `json:"level"`
	Title string `json:"title"`
}
type Metadata struct {
	Headings   []Heading      `json:"headings"`
	Tags       []string       `json:"tags"`
	Properties map[string]any `json:"properties"`
	Links      []string       `json:"links"`
}

var wikiPattern = regexp.MustCompile(`\[\[([^\[\]\n|]+)(?:\|[^\[\]\n]*)?\]\]`)
var tagPattern = regexp.MustCompile(`(?:^|[\s(])#([\pL\pN_][\pL\pN_/-]*)`)
var frontPattern = regexp.MustCompile(`(?s)^---[ \t]*\n(.*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)`)

func metadata(data []byte) Metadata {
	m := Metadata{Headings: []Heading{}, Tags: []string{}, Properties: map[string]any{}, Links: []string{}}
	tags := map[string]bool{}
	data = bytes.ReplaceAll(bytes.TrimPrefix(data, []byte("\uFEFF")), []byte("\r\n"), []byte("\n"))
	if bounds := frontPattern.FindSubmatchIndex(data); bounds != nil {
		var props map[string]any
		if yaml.Unmarshal(data[bounds[2]:bounds[3]], &props) == nil && props != nil {
			// Only expose YAML values representable by the JSON API.
			if _, err := json.Marshal(props); err == nil {
				m.Properties = props
			}
			switch v := props["tags"].(type) {
			case string:
				for _, t := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' }) {
					tags[strings.TrimPrefix(t, "#")] = true
				}
			case []any:
				for _, t := range v {
					if s, ok := t.(string); ok {
						tags[strings.TrimPrefix(s, "#")] = true
					}
				}
			}
		}
		data = data[bounds[1]:]
	}
	doc := goldmark.DefaultParser().Parse(text.NewReader(data))
	var plain strings.Builder
	flush := func() {
		s := plain.String()
		plain.Reset()
		for _, v := range wikiPattern.FindAllStringSubmatch(s, -1) {
			m.Links = append(m.Links, v[1])
		}
		for _, v := range tagPattern.FindAllStringSubmatch(s, -1) {
			tags[v[1]] = true
		}
	}
	ast.Walk(doc, func(n ast.Node, enter bool) (ast.WalkStatus, error) {
		if !enter {
			if n.Type() == ast.TypeBlock {
				flush()
			}
			return ast.WalkContinue, nil
		}
		switch x := n.(type) {
		case *ast.CodeSpan, *ast.CodeBlock, *ast.FencedCodeBlock, *ast.Image, *ast.RawHTML, *ast.HTMLBlock:
			flush()
			return ast.WalkSkipChildren, nil
		case *ast.Heading:
			m.Headings = append(m.Headings, Heading{x.Level, string(x.Text(data))})
		case *ast.Link:
			flush()
			m.Links = append(m.Links, string(x.Destination))
			return ast.WalkSkipChildren, nil
		case *ast.Text:
			plain.Write(x.Segment.Value(data))
			if x.SoftLineBreak() || x.HardLineBreak() {
				plain.WriteByte('\n')
			}
		}
		return ast.WalkContinue, nil
	})
	flush()
	for t := range tags {
		if t != "" {
			m.Tags = append(m.Tags, t)
		}
	}
	sort.Strings(m.Tags)
	return m
}

// Index immutable bytes on demand. Every read joins the current live version, including legacy notes and sync writes.
func (r *Repository) refreshIndex(ctx context.Context, vault string) error {
	rows, err := r.db.QueryContext(ctx, activeFileQuery+` AND f.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM note_index i WHERE i.file_id=f.id AND i.version_id=f.current_version_id AND i.format=f.format)`, vault)
	if err != nil {
		return err
	}
	type item struct {
		id, version, format, hash string
		size                      int64
	}
	var items []item
	for rows.Next() {
		f, e := scanFile(rows)
		if e != nil {
			rows.Close()
			return e
		}
		items = append(items, item{f.ID, *f.CurrentVersionID, f.Format, f.CurrentContentHash, f.CurrentContentSize})
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, f := range items {
		var data []byte
		if f.format != "xmind" {
			data, err = r.readNoteBlob(ctx, vault, f.hash, f.size)
			if err != nil {
				return err
			}
		}
		var m Metadata
		if f.format == "md" {
			m = metadata(data)
		}
		raw, e := json.Marshal(m)
		if e != nil {
			return e
		}
		_, e = r.db.ExecContext(ctx, `INSERT OR REPLACE INTO note_index SELECT id,current_version_id,format,?,? FROM files WHERE id=? AND current_version_id=? AND format=? AND is_deleted=0`, strings.ToLower(string(data)), string(raw), f.id, f.version, f.format)
		if e != nil {
			return e
		}
	}
	return nil
}

type NoteHit struct {
	ID   string `json:"file_id"`
	Path string `json:"path"`
}

const indexedNotes = ` FROM files f JOIN note_index i ON i.file_id=f.id AND i.version_id=f.current_version_id AND i.format=f.format WHERE f.vault_id=? AND f.is_deleted=0 `

func (r *Repository) Search(ctx context.Context, vault, q, tag string) ([]NoteHit, error) {
	if err := r.refreshIndex(ctx, vault); err != nil {
		return nil, err
	}
	q = strings.ToLower(strings.TrimSpace(q))
	rows, err := r.db.QueryContext(ctx, `SELECT f.id,f.path`+indexedNotes+` AND NOT (f.path GLOB '*/.wenote-folder.json' AND f.current_content_hash='sha256:62837e3e3cc858e7102d86bce9f026008296ae23e621644486d155744e372496') AND (instr(i.body,?) OR instr(lower(f.path),?) OR ?='') AND (?='' OR EXISTS(SELECT 1 FROM json_each(i.metadata,'$.tags') WHERE value=?)) ORDER BY f.path`, vault, q, q, q, tag, tag)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := []NoteHit{}
	for rows.Next() {
		var h NoteHit
		if err := rows.Scan(&h.ID, &h.Path); err != nil {
			return nil, err
		}
		hits = append(hits, h)
	}
	return hits, rows.Err()
}
func (r *Repository) Tags(ctx context.Context, vault string) (map[string]int, error) {
	if err := r.refreshIndex(ctx, vault); err != nil {
		return nil, err
	}
	rows, e := r.db.QueryContext(ctx, `SELECT t.value,count(*) FROM files f JOIN note_index i ON i.file_id=f.id AND i.version_id=f.current_version_id AND i.format=f.format JOIN json_each(i.metadata,'$.tags') t WHERE f.vault_id=? AND f.is_deleted=0 GROUP BY t.value`, vault)
	if e != nil {
		return nil, e
	}
	defer rows.Close()
	tags := map[string]int{}
	for rows.Next() {
		var s string
		var n int
		if e := rows.Scan(&s, &n); e != nil {
			return nil, e
		}
		tags[s] = n
	}
	return tags, rows.Err()
}
func resolveNote(from, raw string, paths map[string]string, names map[string]string) string {
	target, _, _ := strings.Cut(raw, "#")
	target, e := url.PathUnescape(strings.TrimSpace(target))
	if e != nil || target == "" || strings.Contains(target, ":") || strings.HasPrefix(target, "//") {
		return ""
	}
	if path.Ext(target) == "" {
		target += ".md"
	}
	if !strings.HasPrefix(target, "/") {
		if id := paths[path.Join(path.Dir(from), target)]; id != "" {
			return id
		}
	}
	if id := paths[strings.TrimPrefix(target, "/")]; id != "" {
		return id
	}
	return names[target]
}
func (r *Repository) Relations(ctx context.Context, vault, id string) (Metadata, []NoteHit, error) {
	var out Metadata
	if _, err := r.File(ctx, vault, id); err != nil {
		return out, nil, err
	}
	if err := r.refreshIndex(ctx, vault); err != nil {
		return out, nil, err
	}
	rows, e := r.db.QueryContext(ctx, `SELECT f.id,f.path,i.metadata`+indexedNotes+` ORDER BY f.path`, vault)
	if e != nil {
		return out, nil, e
	}
	defer rows.Close()
	type entry struct {
		NoteHit
		Metadata
	}
	var entries []entry
	paths, names := map[string]string{}, map[string]string{}
	for rows.Next() {
		var n entry
		var raw []byte
		if e := rows.Scan(&n.ID, &n.Path, &raw); e != nil {
			return out, nil, e
		}
		if e := json.Unmarshal(raw, &n.Metadata); e != nil {
			return out, nil, e
		}
		if n.ID == id {
			out = n.Metadata
		}
		paths[n.Path] = n.ID
		name := path.Base(n.Path)
		if _, ok := names[name]; ok {
			names[name] = ""
		} else {
			names[name] = n.ID
		}
		entries = append(entries, n)
	}
	hits := []NoteHit{}
	for _, n := range entries {
		for _, link := range n.Links {
			if resolveNote(n.Path, link, paths, names) == id {
				hits = append(hits, n.NoteHit)
				break
			}
		}
	}
	return out, hits, rows.Err()
}
